/**
 * Sutando's relay agent: the voice side's task manager between the voice model and the core, run
 * as the bodhi subagent behind the `work` tool. The model hears the tool's pending message at once;
 * each `work` call waits for its task's result and returns it, and bodhi hands it to the model as a
 * system notification when the model is idle. It keeps a table of every task the user asked for by
 * voice (what, when, cancel asked, how its result reached the user, which result answered it) and
 * answers from it; a result whose call is gone is delivered another way and reconciled.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersistentSubagentInstance, SubagentConfig } from 'bodhi-realtime-agent';
import { frameTaskResult, framedSystem } from './inject-framing.js';

/** How a voice task's result reached the user. `injected`: handed to the model, turn never confirmed. */
export type Delivery = 'spoken' | 'injected' | 'dm';

/** One row per task the user asked for by voice. Where the task stands is read from the core, not stored here. */
export interface VoiceTaskRecord {
	text?: string;
	submittedAt?: number;
	cancelRequested?: boolean;
	delivery?: Delivery;
	/** Times the relay handed an unheard result over again. */
	replays?: number;
	/** The user was told the core had not picked it up. */
	notPickedNoticed?: boolean;
	/** The core answered this task in another task's result (`[deduped: <id>]`): its outcome is that result. */
	answeredBy?: string;
	/** The user corrected this request with a later task: its own result is not said. */
	supersededBy?: string;
	/** The core ended it with nothing for the user to hear (a skip-marked result that answers no other task). */
	retired?: boolean;
	/** Last change, for the cap. */
	at: number;
}

const STORE_VERSION = 2;
const STORE_CAP = 200;

/** `state/voice-tasks.json`: the voice task table. One writer, atomic, capped; survives a restart. */
export function createVoiceTaskStore(path: string, now: () => number = Date.now) {
	const read = (): Record<string, VoiceTaskRecord> => {
		try {
			const d = JSON.parse(readFileSync(path, 'utf-8')) as { version?: unknown; tasks?: unknown };
			if (d.version !== STORE_VERSION || !d.tasks || typeof d.tasks !== 'object') return {};
			return d.tasks as Record<string, VoiceTaskRecord>;
		} catch {
			return {};
		}
	};
	const update = (taskId: string, change: (row: VoiceTaskRecord) => VoiceTaskRecord | null) => {
		const tasks = read();
		const next = change(tasks[taskId] ?? { at: 0 });
		if (!next) return;
		tasks[taskId] = { ...next, at: now() };
		const kept = Object.entries(tasks).sort((a, b) => b[1].at - a[1].at).slice(0, STORE_CAP);
		try {
			if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, tasks: Object.fromEntries(kept) }));
			renameSync(tmp, path);
		} catch (err) {
			// A row that cannot be written costs a possible repeat, never a lost result.
			console.error(`[RelayAgent] task table write failed: ${err instanceof Error ? err.message : err}`);
		}
	};
	return {
		get(taskId: string): VoiceTaskRecord | undefined {
			return read()[taskId];
		},
		/** Every row, oldest submission first. */
		list(): Array<[string, VoiceTaskRecord]> {
			return Object.entries(read()).sort((a, b) => (a[1].submittedAt ?? a[1].at) - (b[1].submittedAt ?? b[1].at));
		},
		/** A `work` task was submitted. */
		add(taskId: string, text: string): void {
			update(taskId, (row) => ({ ...row, text: text.slice(0, 200), submittedAt: now() }));
		},
		/** The user asked to cancel it. */
		markCancelRequested(taskId: string): void {
			update(taskId, (row) => ({ ...row, cancelRequested: true }));
		},
		set(taskId: string, delivery: Delivery): void {
			// A confirmed delivery is never downgraded by a later, weaker one.
			const deliver = (row: VoiceTaskRecord) => (row.delivery === 'spoken' && delivery !== 'spoken' ? null : { ...row, delivery });
			update(taskId, deliver);
			// The tasks answered in this one's result reached the user with it, whichever way it went.
			for (const [id, row] of Object.entries(read())) if (row.answeredBy === taskId) update(id, deliver);
		},
		noteReplay(taskId: string): void {
			update(taskId, (row) => ({ ...row, replays: (row.replays ?? 0) + 1 }));
		},
		noteNotPicked(taskId: string): void {
			update(taskId, (row) => ({ ...row, notPickedNoticed: true }));
		},
		/** The core answered `taskId` in `target`'s result. */
		setAnsweredBy(taskId: string, target: string): void {
			if (taskId === target) return;
			// The answering result may already have been handed over: this task went with it.
			const reached = read()[target]?.delivery;
			update(taskId, (row) => ({ ...row, answeredBy: target, ...(reached && row.delivery !== 'spoken' ? { delivery: reached } : {}) }));
		},
		/** The user corrected `taskId` with `by`. */
		markRetired(taskId: string): void {
			update(taskId, (row) => ({ ...row, retired: true }));
		},
		setSupersededBy(taskId: string, by: string): void {
			if (taskId === by) return;
			update(taskId, (row) => ({ ...row, supersededBy: by }));
		},
		/** The rows the core answered in `target`'s result. */
		answeredBy(target: string): Array<[string, VoiceTaskRecord]> {
			return Object.entries(read()).filter(([, row]) => row.answeredBy === target);
		},
	};
}

export type VoiceTaskStore = ReturnType<typeof createVoiceTaskStore>;

/** Where the core says a task stands, read fresh each time. */
export type CoreTaskState = 'queued' | 'started' | 'done' | 'cancelled' | 'unknown';

export interface ReconcileInput {
	row: VoiceTaskRecord;
	core: CoreTaskState;
	/** The core wrote a result and the watcher has already handled it (not one still landing). */
	settledResult: boolean;
	/** That result is a skip marker ([deduped: X], [no-send], [REPLIED]): its outcome lives elsewhere. */
	resultIsSkip: boolean;
	/** The result is in the queue right now. */
	inFlight: boolean;
	now: number;
}

export type ReconcileAction = 'none' | 'speak_result' | 'tell_not_picked';

/** Hand an unheard result over at most this many more times. */
export const MAX_REPLAYS = 2;
/** A task the core has not picked up after this long is reported once. */
export const NOT_PICKED_MS = 3 * 60 * 1000;

/**
 * The relay agent's one rule: every voice task ends in an outcome the user heard. Compares what
 * the core did with what the user was told and returns what is still owed.
 */
export function planReconcile(i: ReconcileInput): ReconcileAction {
	if (i.row.supersededBy) return 'none';
	if (i.settledResult) {
		if (i.resultIsSkip || i.inFlight) return 'none';
		if (i.row.delivery === 'spoken' || i.row.delivery === 'injected') return 'none';
		return (i.row.replays ?? 0) < MAX_REPLAYS ? 'speak_result' : 'none';
	}
	if (i.core === 'queued' && !i.row.cancelRequested && !i.row.notPickedNoticed
		&& i.row.submittedAt !== undefined && i.now - i.row.submittedAt > NOT_PICKED_MS) return 'tell_not_picked';
	return 'none';
}

export interface ResultItem {
	text: string;
	note?: string;
	taskId?: string;
	/** `text` is already framed for the model (not a task result), e.g. a finished phone call. */
	framed?: boolean;
	/** What the user asked for, so the model can match the result to each request it answers. */
	requests?: string[];
	/** Other voice tasks this result answers (the core deduped them into it): recorded with it. */
	alsoFor?: string[];
	/** A message with no task of its own that speaks for these voice tasks (see coveredTasks). */
	covers?: string[];
	/** A status notice about this task (not its result): not said once it is no longer true. */
	about?: string;
}

// Results can arrive minutes later and several in a row: the user hears which request each one answers.
export const SAY_WHICH_ONE = 'Start by saying in a few words, in the user\'s language, which request this answers (e.g. "About the PR 5200 comment: …"), then the answer.';
export const SAY_WHICH_EACH = 'Name each request, in a few words in the user\'s language, before its answer.';

/** The text handed to the model for one result: the requests it answers, the result, any note. */
export function frameResult(i: ResultItem): string {
	const quote = (r: string) => `"${r.replace(/"/g, "'")}"`;
	const rs = (i.requests ?? []).filter(Boolean);
	const asked = rs.length === 0
		? ''
		: rs.length === 1
			? `${framedSystem(`This answers the user's request: ${quote(rs[0])}. ${SAY_WHICH_ONE}`)}\n\n`
			: `${framedSystem(`This answers ${rs.length} of the user's requests: ${rs.map(quote).join('; ')}. Cover each of them. ${SAY_WHICH_EACH}`)}\n\n`;
	return asked + (i.framed ? i.text : frameTaskResult(i.text)) + (i.note ? `\n\n${framedSystem(i.note)}` : '');
}

/** A correction reaches back this far for the request it replaces. */
export const SUPERSEDE_WINDOW_MS = 60 * 60_000;

/** A result the table says needs no saying: its task was corrected, or every task it answers was heard. */
export function resultIsMoot(store: VoiceTaskStore, ids: string[]): boolean {
	if (!ids.length) return false;
	if (store.get(ids[0])?.supersededBy) return true;
	return ids.every((id) => store.get(id)?.delivery === 'spoken');
}

/** What identifies a request beyond doubt: numbers of three or more digits, and quoted names. */
export function requestMarks(request: string): string[] {
	const numbers = request.match(/\d{3,}/g) ?? [];
	const quoted = [...request.matchAll(/["“「]([^"”」]{2,})["”」]/g)].map((m) => m[1].toLowerCase());
	return [...new Set([...numbers, ...quoted])];
}

/**
 * The open voice tasks a message with no task of its own (a summary the core wrote) speaks for:
 * those whose request marks all appear in it. A request with no such mark is never matched, so
 * an unmatched result is said as usual; a guess could only drop one.
 */
export function coveredTasks(store: VoiceTaskStore, text: string, now = Date.now()): string[] {
	const lower = text.toLowerCase();
	const has = (mark: string) => /^\d+$/.test(mark) ? new RegExp(`(?<!\\d)${mark}(?!\\d)`).test(text) : lower.includes(mark);
	return store.list()
		.filter(([, row]) => row.delivery !== 'spoken' && !row.supersededBy && now - (row.submittedAt ?? 0) < SUPERSEDE_WINDOW_MS)
		.filter(([, row]) => { const marks = requestMarks(row.text ?? ''); return marks.length > 0 && marks.every(has); })
		.map(([id]) => id);
}

/** How long a handed-over result waits for the model's turn before the next one goes anyway. */
export const HANDOFF_CONFIRM_MS = 60_000;

/** How long a result waits for the model to answer what the user just said (noise can end a user turn no reply follows). */
export const USER_REPLY_WAIT_MS = 8_000;

/** How long the user stays quiet before a `work` call is submitted: a pause mid-sentence is shorter. */
export const QUIET_BEFORE_SUBMIT_MS = 1_500;

/** A `work` call is never held longer than this, whatever the speech events say. */
export const MAX_SUBMIT_HOLD_MS = 30_000;

/**
 * Whether the user has finished their turn. The model can end the user's turn mid-sentence (a short
 * pause) and call `work` with half a request; the relay agent waits on this before it submits. The
 * turn is over once the user has been quiet a moment, or once the model has spoken to them: what the
 * user says after the model's reply is a new request, never the rest of this one.
 */
export interface SpeechGate {
	onUserSpeechStarted(): void;
	onUserSpeechEnded(): void;
	/** The model started speaking to the user. */
	onModelAudio(): void;
	/** Resolves once the user's turn is over, or the hold limit or `signal` ends the wait. */
	waitTurnOver(signal?: AbortSignal): Promise<void>;
}

export function createSpeechGate(opts: { quietMs?: number; maxHoldMs?: number; now?: () => number } = {}): SpeechGate {
	const now = opts.now ?? Date.now;
	const quietMs = opts.quietMs ?? QUIET_BEFORE_SUBMIT_MS;
	const maxHoldMs = opts.maxHoldMs ?? MAX_SUBMIT_HOLD_MS;
	let speaking = false;
	let startedAt = 0;
	let endedAt: number | null = null;
	let modelAudioAt: number | null = null;
	// Every wait looks again on each event, so the model's first word releases a call at once.
	const waits = new Set<() => void>();
	const wake = () => { for (const look of [...waits]) look(); };
	return {
		onUserSpeechStarted() { speaking = true; startedAt = now(); wake(); },
		onUserSpeechEnded() { speaking = false; endedAt = now(); wake(); },
		onModelAudio() { modelAudioAt = now(); wake(); },
		waitTurnOver(signal) {
			const since = now();
			return new Promise<void>((resolve) => {
				let timer: ReturnType<typeof setTimeout> | null = null;
				const done = () => { waits.delete(look); if (timer) clearTimeout(timer); resolve(); };
				function look() {
					const t = now();
					if (signal?.aborted || t - since >= maxHoldMs) return done();
					// The model answered: the user's turn is over, whatever the microphone picks up now.
					if (modelAudioAt !== null && modelAudioAt >= since) return done();
					// A speech start with no end (a sound too short to be speech) does not hold the call for good.
					const stillSpeaking = speaking && t - startedAt < maxHoldMs;
					const quietFrom = stillSpeaking ? null : (endedAt ?? 0) + quietMs;
					if (quietFrom !== null && t >= quietFrom) return done();
					if (timer) clearTimeout(timer);
					timer = setTimeout(look, quietFrom === null ? Math.max(10, since + maxHoldMs - t) : Math.max(10, quietFrom - t));
				}
				waits.add(look);
				signal?.addEventListener('abort', look, { once: true });
				look();
			});
		},
	};
}

/** The request a cut-off call sent, joined to the one the user went on to say. */
export function joinCutOffRequest(earlier: string, later: string): string {
	return `${later}\n\n[The user's words just before this were cut off mid-sentence and are sent with it: "${earlier.replace(/"/g, "'")}". If they ask for something this does not cover, do that too.]`;
}

/** One result on its way to the model. */
export interface Handoff {
	/** The tasks it answers: recorded spoken once the model has said it. */
	ids: string[];
	label: string;
	/** Hands it to the model now (its waiting work call or a system notice). False when it cannot. */
	hand(): boolean;
	/** Hands it again after a cut-off answer. */
	rehand(): boolean;
	/** It could not be handed: deliver it another way. */
	fallback(): void;
	/** The table says it no longer needs saying (checked when its turn comes). */
	moot?(): boolean;
}

/**
 * Hands results to the model one at a time and confirms each from the model's next turn: a turn
 * that finishes records it spoken; one cut off hands it over once more. Two results landing at
 * once would otherwise reach the model together, and it may answer only one. A result also waits
 * while the user speaks and until the model has answered them, so it never takes the user's turn.
 * Only a turn the model spoke in counts: a turn that was only a tool call answered no one.
 */
export function createHandoffPacer(deps: {
	markSpoken: (ids: string[]) => void;
	confirmMs?: number;
	userReplyWaitMs?: number;
	now?: () => number;
	log?: (msg: string) => void;
}) {
	const now = deps.now ?? Date.now;
	let userSpeaking = false;
	let userStartedAt = 0;
	let userEndedAt: number | null = null;
	let userTimer: ReturnType<typeof setTimeout> | null = null;
	let spoke = false;
	// A speech start with no end (a dropped event) must not hold results for good.
	const speakingHold = () => userSpeaking && now() - userStartedAt < (deps.confirmMs ?? HANDOFF_CONFIRM_MS);
	const userTurnOpen = () =>
		speakingHold() || (userEndedAt !== null && now() - userEndedAt < (deps.userReplyWaitMs ?? USER_REPLY_WAIT_MS));
	const queue: Handoff[] = [];
	let current: { h: Handoff; started: boolean; retried: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
	const busyWith = (ids: string[]) =>
		[...(current ? [current.h] : []), ...queue].some((h) => h.ids.some((id) => ids.includes(id)));
	const release = () => {
		if (current) clearTimeout(current.timer);
		current = null;
		pump();
	};
	const arm = () => {
		const timer = setTimeout(() => {
			deps.log?.(`[RelayAgent] ${current?.h.label}: no turn after the hand-off; moving on`);
			release();
		}, deps.confirmMs ?? HANDOFF_CONFIRM_MS);
		timer.unref?.();
		return timer;
	};
	function pump(): void {
		if (!current && queue.length && userTurnOpen()) {
			// Look again when the wait runs out; every user turn that ends starts it over.
			const until = speakingHold()
				? userStartedAt + (deps.confirmMs ?? HANDOFF_CONFIRM_MS)
				: (userEndedAt ?? now()) + (deps.userReplyWaitMs ?? USER_REPLY_WAIT_MS);
			if (userTimer) clearTimeout(userTimer);
			userTimer = setTimeout(() => { userTimer = null; pump(); }, Math.max(0, until - now()));
			userTimer.unref?.();
			return;
		}
		while (!current && queue.length) {
			const h = queue.shift()!;
			if (h.moot?.()) { deps.log?.(`[RelayAgent] ${h.label}: already heard or corrected; not said`); continue; }
			if (!h.hand()) { h.fallback(); continue; }
			current = { h, started: false, retried: false, timer: arm() };
		}
	}
	return {
		/** Queue a result; one already queued or on its way for the same task is not queued twice. */
		submit(h: Handoff): void {
			if (h.ids.length && busyWith(h.ids)) return;
			queue.push(h);
			pump();
		},
		onUserSpeechStarted(): void {
			userSpeaking = true;
			userStartedAt = now();
		},
		onUserSpeechEnded(): void {
			userSpeaking = false;
			userEndedAt = now();
			if (!current) pump();
		},
		onTurnStart(): void {
			spoke = false;
			if (current) current.started = true;
		},
		/** The model's audio began in this turn. */
		onModelAudio(): void {
			spoke = true;
		},
		onTurnEnd(interrupted: boolean): void {
			const spokeInTurn = spoke;
			spoke = false;
			// A silent turn (a tool call only) answered nothing and said nothing.
			if (!spokeInTurn) return;
			// A finished, spoken model turn answered whatever the user had said.
			if (!interrupted && !userSpeaking) {
				userEndedAt = null;
				if (userTimer) { clearTimeout(userTimer); userTimer = null; }
				if (!current) pump();
			}
			if (!current?.started) return;
			if (!interrupted) {
				deps.markSpoken(current.h.ids);
				release();
				return;
			}
			if (current.retried || !current.h.rehand()) {
				deps.log?.(`[RelayAgent] ${current.h.label}: answer cut off again; leaving it`);
				release();
				return;
			}
			deps.log?.(`[RelayAgent] ${current.h.label}: answer cut off; handing it over again`);
			clearTimeout(current.timer);
			current = { ...current, started: false, retried: true, timer: arm() };
		},
		/** Whether a result for this task is queued or on its way to the model. */
		has(taskId: string): boolean {
			return busyWith([taskId]);
		},
		get pending(): number {
			return queue.length + (current ? 1 : 0);
		},
	};
}

/** Submits one `work` call to the core: the tool's own execute, returning its status object. */
export type SubmitWork = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface RelayAgentDeps {
	submit: SubmitWork;
	store: VoiceTaskStore;
	/** Says a line to the model now (the queue position at submission). */
	notice?: (text: string) => void;
	/** Holds each call until the user has finished speaking. Without it, calls are submitted at once. */
	speech?: SpeechGate;
	log?: (msg: string) => void;
}

interface Waiter {
	resolve: (text: string) => void;
	reject: (err: Error) => void;
}

/** How a waiting call ends without its result. bodhi reads a rejection out as a failure, so none rejects. */
const ENDED: Record<'cancelled' | 'continuing' | 'delivered_separately' | 'continued_in_next', string> = {
	continued_in_next: 'The user was not finished: this request was sent together with what they said next. Say nothing about it.',
	cancelled: 'The user cancelled this task and was already told. Do not mention it again.',
	continuing: 'The task is still running; its result will come in a separate message.',
	delivered_separately: 'This task\'s result is delivered to the user separately. Say nothing about it now.',
};

/**
 * The `work` subagent. `invoke` submits the task and, unless the status is the answer (a duplicate,
 * a rejection, the fast path), waits for the task's result and returns it. `offerResult` hands a
 * landed result to its waiting call; it refuses (the caller delivers another way) when no call waits.
 */
export class RelayAgent implements PersistentSubagentInstance {
	readonly key = 'relay-agent';
	private readonly waiting = new Map<string, Waiter>();
	/** The call waiting for the user to finish speaking, not yet submitted. */
	private holding: { args: Record<string, unknown>; joined: boolean } | null = null;

	constructor(private readonly deps: RelayAgentDeps) {}

	async invoke(_task: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		if (this.deps.speech) {
			// A call made while an earlier one still waits for the user's turn to end: the model has not
			// answered in between, the user went on speaking, so the two are one request. The earlier
			// call ends; this one carries both.
			const earlier = this.holding;
			if (earlier) {
				earlier.joined = true;
				args = {
					...earlier.args,
					...args,
					task: joinCutOffRequest(String(earlier.args.task ?? ''), String(args.task ?? '')),
				};
				this.deps.log?.('[RelayAgent] the user went on speaking: the earlier request is sent with this one');
			}
			const mine = { args, joined: false };
			this.holding = mine;
			await this.deps.speech.waitTurnOver(signal);
			if (mine.joined) return framedSystem(ENDED.continued_in_next);
			if (this.holding === mine) this.holding = null;
		}
		const submitted = await this.deps.submit(args);
		const taskId = submitted.taskId;
		if (submitted.status !== 'pending' || typeof taskId !== 'string') return JSON.stringify(submitted);
		const replaces = typeof args.replaces === 'string' ? args.replaces.trim() : '';
		if (replaces) this.supersede(taskId, replaces);

		// The ordinary "working on it" is the tool's pending message; a queue position or an offline core is said now.
		const unusual = (typeof submitted.queuedAhead === 'number' && submitted.queuedAhead > 0) || submitted.watcherOnline === false;
		if (unusual && typeof submitted.message === 'string') this.deps.notice?.(framedSystem(submitted.message));
		if (signal?.aborted) return framedSystem(ENDED.continuing);
		return new Promise<string>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject };
			this.waiting.set(taskId, waiter);
			signal?.addEventListener('abort', () => {
				if (this.endCall(taskId, 'continuing'))
					this.deps.log?.(`[RelayAgent] ${taskId}: work call ended before its result; delivering it another way`);
			}, { once: true });
		});
	}

	/** A result landed. True when its call is waiting and now returns it. */
	offerResult(item: ResultItem): boolean {
		const taskId = item.taskId;
		if (!taskId) return false;
		const waiter = this.waiting.get(taskId);
		if (!waiter) return false;
		this.waiting.delete(taskId);
		for (const id of [taskId, ...(item.alsoFor ?? [])]) this.deps.store.set(id, 'injected');
		waiter.resolve(frameResult(item));
		// The tasks answered in this result wait on calls whose own result never comes: end them.
		for (const id of item.alsoFor ?? []) {
			const other = this.waiting.get(id);
			if (!other) continue;
			this.waiting.delete(id);
			other.resolve(JSON.stringify({ status: 'answered_together', taskId: id, answeredIn: taskId }));
		}
		return true;
	}

	/**
	 * The model said this task corrects an earlier request (`replaces` names it, e.g. a misheard
	 * number). The table marks every recent request containing those words, not yet heard, as
	 * superseded: its result is not said, and its waiting call ends.
	 */
	private supersede(taskId: string, replaces: string): void {
		const needle = replaces.toLowerCase();
		const since = Date.now() - SUPERSEDE_WINDOW_MS;
		for (const [id, row] of this.deps.store.list()) {
			if (id === taskId || row.delivery === 'spoken' || row.supersededBy || (row.submittedAt ?? 0) < since) continue;
			if (!row.text?.toLowerCase().includes(needle)) continue;
			this.deps.store.setSupersededBy(id, taskId);
			this.endCall(id, 'delivered_separately');
			this.deps.log?.(`[RelayAgent] ${id}: corrected by ${taskId}; its result will not be said`);
		}
	}

	/** Ends the call waiting on `taskId` without its result. False when none waits. */
	endCall(taskId: string, why: keyof typeof ENDED): boolean {
		const waiter = this.waiting.get(taskId);
		if (!waiter) return false;
		this.waiting.delete(taskId);
		waiter.resolve(framedSystem(ENDED[why]));
		return true;
	}

	/** Whether a `work` call is waiting on `taskId`. */
	isWaiting(taskId: string): boolean {
		return this.waiting.has(taskId);
	}

	async dispose(): Promise<void> {
		for (const { reject } of this.waiting.values()) reject(new Error('relay agent disposed'));
		this.waiting.clear();
	}
}

/** The bodhi subagent config for the `work` tool: one relay agent per voice session. */
export function relayAgentSubagentConfig(agent: RelayAgent): SubagentConfig {
	return {
		name: 'relay-agent',
		instructions: 'Relays a work task to the core and returns its result.',
		tools: {},
		lifetime: 'persistent_session',
		persistentFactory: async () => agent,
	};
}
