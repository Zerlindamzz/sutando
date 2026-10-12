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
export const WORK_CHECK_TIMEOUT_MS = 4_000;

export function workCheckPrompt(i: WorkCheckInput): string {
	return [
		'A voice assistant wrote a request for its back-end agent (the core), which does lookups, actions and file work. Before it is sent, decide one thing: does the request identify WHICH thing it is about?',
		'Rules:',
		'- The request is about a specific thing when it names a type: a PR, an issue, a file, a document, a person, a repository, a meeting, a place.',
		'- It identifies it when it gives the number, name or title, or when the recent words do.',
		'- "the PR", "that file", "the meeting" with no number, name or title anywhere = not identified.',
		'Reply with JSON only:',
		'{"action":"ask","question":"..."} when a specific thing is not identified. One short question in the user\'s language asking only for the missing piece.',
		'{"action":"submit"} otherwise, including requests about no specific thing (a general summary, a search, a how-to).',
		'Examples:',
		'Request "Check the status of the PR"; recent words "帮我查一下那个 PR 的状态" -> {"action":"ask","question":"你说的是哪个 PR？"}',
		'Request "Check the status of PR 5302"; recent words "帮我查一下 PR5302 的状态" -> {"action":"submit"}',
		'Request "Summarize the meeting notes"; recent words "帮我总结一下会议纪要" -> {"action":"ask","question":"哪一场会议的纪要？"}',
		'Request "List the PRs merged this week in sonichi/sutando" -> {"action":"submit"}',
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
		const t0 = Date.now();
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? WORK_CHECK_TIMEOUT_MS);
		signal?.addEventListener('abort', () => ctl.abort(), { once: true });
		try {
			const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contents: [{ parts: [{ text: workCheckPrompt(input) }] }],
					// A thinking model spends the output budget on thinking and returns a cut-off "{"action":" (seen 2026-10-12):
					// thinking off, JSON out.
					generationConfig: { maxOutputTokens: 200, temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
				}),
				signal: ctl.signal,
			});
			const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
			const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
			if (!text) {
				opts.log?.(`[RelayAgent] work check gave no answer (${data.error?.message ?? 'empty'}); submitting`);
				return { action: 'submit' };
			}
			const verdict = parseWorkCheck(text);
			opts.log?.(`[RelayAgent] work check: ${verdict.action}${verdict.action === 'ask' ? ` (${verdict.question})` : ''} in ${Date.now() - t0}ms`);
			return verdict;
		} catch (err) {
			opts.log?.(`[RelayAgent] work check failed (${err instanceof Error ? err.message : String(err)}); submitting`);
			return { action: 'submit' };
		} finally {
			clearTimeout(timer);
		}
	};
}
