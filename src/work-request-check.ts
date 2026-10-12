/**
 * The relay agent's check on a `work` request before it is submitted: can the core act on it as
 * written, or is something missing that only the user can supply (which PR, which file, who)?
 *
 * The voice model decides fluently and does not stop to ask (2026-10-12: four prompt revisions,
 * zero questions asked; a blank request was submitted or an answer was invented). A text model
 * asked one question follows instructions, so the decision lives here, outside the voice model.
 * Any failure or delay lets the request through: the check never blocks work.
 */

export type WorkCheck = { action: 'submit' } | { action: 'ask'; question: string };

export interface WorkCheckInput {
	/** The request the voice model wrote for the core. */
	task: string;
	/** The user's and assistant's recent words, oldest first. */
	recentConversation: string;
}

export type WorkRequestCheck = (input: WorkCheckInput, signal?: AbortSignal) => Promise<WorkCheck>;

export const WORK_CHECK_MODEL = process.env.WORK_CHECK_MODEL || 'gemini-3-flash-preview';
export const WORK_CHECK_TIMEOUT_MS = 2_500;

export function workCheckPrompt(i: WorkCheckInput): string {
	return [
		'A voice assistant is about to send this request to its back-end agent (the core), which does lookups, actions and file work.',
		'Decide whether the request can go as written. Reply with JSON only, one object, no prose.',
		'{"action":"submit"} - the request says what it is about (which PR, file, person, place, repository, ...), or the recent words make that clear.',
		'{"action":"ask","question":"..."} - a name, number or target is missing and the recent words do not supply it. The question is ONE short sentence in the user\'s language, asking only for the missing piece.',
		'Prefer submit when in doubt. Never add facts.',
		'',
		'Recent words (oldest first):',
		i.recentConversation.trim() || '(none)',
		'',
		'Request the assistant wrote:',
		i.task.trim(),
	].join('\n');
}

/** The model's reply as a decision. Anything that is not a clear ask means submit. */
export function parseWorkCheck(text: string): WorkCheck {
	const m = /\{[\s\S]*\}/.exec(text);
	if (!m) return { action: 'submit' };
	try {
		const d = JSON.parse(m[0]) as { action?: unknown; question?: unknown };
		if (d.action === 'ask' && typeof d.question === 'string' && d.question.trim()) return { action: 'ask', question: d.question.trim() };
	} catch { /* not JSON: submit */ }
	return { action: 'submit' };
}

export function createGeminiWorkCheck(opts: { apiKey: () => string | undefined; model?: string; timeoutMs?: number; log?: (m: string) => void }): WorkRequestCheck {
	const model = opts.model ?? WORK_CHECK_MODEL;
	return async (input, signal) => {
		const apiKey = opts.apiKey();
		if (!apiKey) return { action: 'submit' };
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? WORK_CHECK_TIMEOUT_MS);
		signal?.addEventListener('abort', () => ctl.abort(), { once: true });
		try {
			const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contents: [{ parts: [{ text: workCheckPrompt(input) }] }],
					generationConfig: { maxOutputTokens: 120, temperature: 0 },
				}),
				signal: ctl.signal,
			});
			const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
			const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
			if (!text) {
				opts.log?.(`[RelayAgent] work check gave no answer (${data.error?.message ?? 'empty'}); submitting`);
				return { action: 'submit' };
			}
			return parseWorkCheck(text);
		} catch (err) {
			opts.log?.(`[RelayAgent] work check failed (${err instanceof Error ? err.message : String(err)}); submitting`);
			return { action: 'submit' };
		} finally {
			clearTimeout(timer);
		}
	};
}
