// Hook wiring for auto-retro. No omp imports, so test.ts can drive it under plain bun.
//
// Trigger: `agent_end`. It is notification-only and emitted after the session settles to idle, so nothing
// here can hold up the UI. (`session_stop` would run before settle, for main sessions only, and its
// continuation would spend the main model; the retro must run on the cheap smol chain.) The work runs
// detached inside try/catch, aborts the moment the user continues, and fails open: any error means no retro.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JudgeRequest } from "../jev-tier/core";
import {
	DEFAULT_CONFIG,
	analyze,
	appendRetro,
	formatLog,
	isOff,
	judgeStop,
	parseConfig,
	preGate,
	readGitView,
	retroEntry,
	retroPrompt,
	retroSystem,
	stopState,
	workRepoBlocker,
	type Config,
	type ExecFn,
	type RetroMeta,
} from "./core";

export interface ExtensionContext {
	mode?: string;
	cwd?: string;
	agent?: { kind?: string };
	isIdle?(): boolean;
	hasPendingMessages?(): boolean;
	model?: unknown;
	modelRegistry?: unknown;
	sessionManager?: {
		getSessionId?(): string;
		getBranch?(): readonly unknown[];
	};
}

export interface ExtensionAPI {
	on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown): void;
	sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }): void;
}

export interface Generated {
	text: string;
	/** `provider/id` of the model that answered. */
	model: string;
}

export interface Dependencies {
	/** Jev through jev-tier's native judge; throws when Jev is unavailable. */
	judge(context: ExtensionContext, request: JudgeRequest): Promise<unknown>;
	/** One completion on the smol role chain at low effort; throws when every candidate fails. */
	generate(context: ExtensionContext, request: { system: string; prompt: string; signal: AbortSignal }): Promise<Generated>;
	exec: ExecFn;
	/** SKILL.md text, or undefined when the skill is missing. */
	readSkill(): string | undefined;
	now?(): Date;
	retroDir?: string;
	logPath?: string;
	configPath?: string;
	/** How long after agent_end to wait for the session to report idle (default 3000). */
	idleWaitMs?: number;
}

interface AgentEndEvent {
	willContinue?: boolean;
}

interface SessionState {
	ran: boolean;
	running: boolean;
	judgedKey: string | undefined;
	/** Bumped by agent_start and session switches: a new turn or session means the work was not over. */
	epoch: number;
	abort?: AbortController;
	/** The check that holds `running`, with the epoch it started in; never rejects. */
	current?: { epoch: number; done: Promise<void> };
}

const agentDir = join(homedir(), ".omp", "agent");
export const defaultPaths = {
	config: join(agentDir, "extensions", "auto-retro", "config.json"),
	log: join(agentDir, "logs", "auto-retro.log"),
	retros: join(agentDir, "retros"),
	skill: join(agentDir, "skills", "retro", "SKILL.md"),
};

function readConfig(path: string): Config {
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export interface Handle {
	/** Resolves when every in-flight retro check has settled. For tests. */
	settled(): Promise<void>;
}

export function register(pi: ExtensionAPI, deps: Dependencies): Handle {
	const now = deps.now ?? (() => new Date());
	const logPath = deps.logPath ?? defaultPaths.log;
	const configPath = deps.configPath ?? defaultPaths.config;
	const retroDir = deps.retroDir ?? defaultPaths.retros;
	const sessions = new Map<string, SessionState>();
	const inFlight = new Set<Promise<void>>();

	const log = (line: string): void => {
		try {
			mkdirSync(dirname(logPath), { recursive: true });
			appendFileSync(logPath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
		} catch {
			// Logging must never hold or break a session.
		}
	};

	const stateFor = (sessionId: string): SessionState => {
		let state = sessions.get(sessionId);
		if (!state) {
			state = { ran: false, running: false, judgedKey: undefined, epoch: 0 };
			sessions.set(sessionId, state);
		}
		return state;
	};

	// agent_end is emitted from inside the settle path, before omp clears its streaming flag, so `isIdle()`
	// is still false when the handler starts. Give it a bounded moment to flip; a new turn ends the wait.
	const waitUntilIdle = async (context: ExtensionContext, state: SessionState, epoch: number): Promise<void> => {
		const deadline = Date.now() + (deps.idleWaitMs ?? 3000);
		const settled = (): boolean => (context.isIdle?.() ?? false) && !(context.hasPendingMessages?.() ?? false);
		while (state.epoch === epoch && Date.now() < deadline && !settled()) await Bun.sleep(50);
	};

	const check = async (event: AgentEndEvent, context: ExtensionContext): Promise<void> => {
		const config = readConfig(configPath);
		if (isOff(process.env, config)) return;
		const sessionId = context.sessionManager?.getSessionId?.();
		if (!sessionId || !context.sessionManager?.getBranch) return;
		const state = stateFor(sessionId);
		const skip = (reason: string, extra: { verdict?: string; confidence?: number } = {}): void =>
			log(formatLog(sessionId, "skip", reason, extra, now()));

		const sameSession = (): boolean => context.sessionManager?.getSessionId?.() === sessionId;
		// Subagents and `willContinue` stops never wait: the gate below rejects them without a model call.
		if (context.agent?.kind === "main" && event.willContinue !== true) {
			const startEpoch = state.epoch;
			await waitUntilIdle(context, state, startEpoch);
			if (state.epoch !== startEpoch || !sameSession()) return skip("a new turn started");
		}
		// A check from an earlier stop is still on Jev or gh (the user sent a short follow-up and that turn ended
		// too): let it settle, then judge this stop instead of dropping it as "in flight".
		const earlier = state.current;
		if (earlier && earlier.epoch !== state.epoch) await earlier.done;

		const entries = context.sessionManager.getBranch();
		const facts = analyze(entries, config.messages);
		const gate = preGate({
			facts,
			config,
			agentKind: context.agent?.kind,
			uiMode: context.mode,
			willContinue: event.willContinue === true,
			idle: context.isIdle?.() ?? false,
			hasPending: context.hasPendingMessages?.() ?? false,
			running: state.running,
			ran: state.ran,
			judgedKey: state.judgedKey,
		});
		if (gate) return skip(gate);

		const skill = deps.readSkill();
		if (!skill) return skip("retro skill missing");

		state.running = true;
		const epoch = state.epoch;
		const done = Promise.withResolvers<void>();
		state.current = { epoch, done: done.promise };
		// Stale = another turn started since this stop, or the session was switched under us (/new, /resume):
		// the work was not over, or the retro would land in the wrong session.
		const stale = (): boolean => state.epoch !== epoch || !sameSession() || !(context.isIdle?.() ?? false);
		try {
			const cwd = context.cwd ?? process.cwd();
			const git = await readGitView(deps.exec, cwd, facts.touched);
			if (stale()) return skip("a new turn started");

			let verdict: { verdict: string; confidence: number };
			try {
				verdict = await judgeStop((request) => deps.judge(context, request), stopState(facts, git), config);
			} catch (error) {
				// Jev down, key rejected, timeout, or no native judge: quiet skip, one log line, no UI.
				state.judgedKey = facts.key;
				const message = error instanceof Error ? error.message : String(error);
				return skip(`jev error: ${message.replace(/\s+/g, " ").slice(0, 120)}`);
			}
			state.judgedKey = facts.key;
			const verdictInfo = { verdict: verdict.verdict, confidence: verdict.confidence };
			if (verdict.verdict !== "finished") return skip(`jev says ${verdict.verdict}`, verdictInfo);
			if (verdict.confidence < config.minConfidence) {
				return skip(`low confidence ${verdict.confidence} < ${config.minConfidence}`, verdictInfo);
			}
			for (const repo of git.repos.filter((r) => r.work)) {
				const blocker = await workRepoBlocker(repo, deps.exec);
				if (blocker) return skip(blocker, verdictInfo);
			}
			if (stale()) return skip("a new turn started", verdictInfo);

			const meta: RetroMeta = {
				repo: git.primary.remote ?? cwd,
				branch: git.primary.branch ?? "-",
				sessionId,
				models: facts.models,
			};
			const abort = new AbortController();
			state.abort = abort;
			const timer = setTimeout(() => abort.abort(), config.generateTimeoutMs);
			let generated: Generated;
			try {
				generated = await deps.generate(context, { system: retroSystem(skill), prompt: retroPrompt(facts, meta), signal: abort.signal });
			} catch (error) {
				if (state.epoch === epoch) {
					// A genuine failure, not the user moving on: give up for this session so it cannot repeat.
					state.ran = true;
				}
				const message = error instanceof Error ? error.message : String(error);
				return skip(`retro generation failed: ${message.replace(/\s+/g, " ").slice(0, 120)}`, verdictInfo);
			} finally {
				clearTimeout(timer);
				state.abort = undefined;
			}
			const report = generated.text.trim();
			if (report.length < 20) {
				state.ran = true;
				return skip("retro generation returned no usable report", verdictInfo);
			}
			if (stale()) return skip("a new turn started", verdictInfo);

			// Mark first: whatever fails below, this session never retries.
			state.ran = true;
			const file = appendRetro(retroDir, now(), retroEntry(now(), meta, report, generated.model));
			pi.sendMessage({
				customType: "retro",
				content: `Retro (auto, ${generated.model}), saved to ${file}\n\n${report}`,
				display: true,
				details: { file, model: generated.model, verdict: verdict.verdict, confidence: verdict.confidence },
			});
			log(formatLog(sessionId, "run", `retro appended to ${file} via ${generated.model}`, verdictInfo, now()));
		} finally {
			state.running = false;
			if (state.current?.done === done.promise) state.current = undefined;
			done.resolve();
		}
	};

	// Anything that moves the session on: a new turn, /new, /resume, /fork, /tree. Cancels a retro in flight.
	const interrupt = (_event: unknown, context: ExtensionContext): void => {
		const sessionId = context.sessionManager?.getSessionId?.();
		const state = sessionId ? sessions.get(sessionId) : undefined;
		if (!state) return;
		state.epoch++;
		state.abort?.abort();
	};
	for (const event of ["agent_start", "session_before_switch", "session_before_branch", "session_before_tree"]) pi.on(event, interrupt);

	pi.on("session_shutdown", (_event, context) => {
		const sessionId = context.sessionManager?.getSessionId?.();
		const state = sessionId ? sessions.get(sessionId) : undefined;
		state?.abort?.abort();
	});

	pi.on("agent_end", (rawEvent, context) => {
		// Detached on purpose: the notification must return at once. A raw detached promise that throws takes
		// the session down, so the catch below is the only exit.
		const task = check((rawEvent ?? {}) as AgentEndEvent, context).catch((error: unknown) => {
			log(`${now().toISOString()} action=error reason=${JSON.stringify(error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160))}`);
		});
		inFlight.add(task);
		void task.finally(() => inFlight.delete(task));
	});

	return {
		async settled() {
			while (inFlight.size > 0) await Promise.all([...inFlight]);
		},
	};
}
