// Pure logic for the auto-retro extension. No omp imports, so test.ts can drive it.
// Jev plumbing (askChoice, rubric, redact) is reused from jev-tier/core.

import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { askChoice, redact, rubric, type ChoiceQuestion, type JudgeFn } from "../jev-tier/core";

// ---------------------------------------------------------------- config / kill switch

export interface Config {
	/** `enabled: false` in config.json; OMP_AUTO_RETRO=0 also turns the extension off. */
	enabled: boolean;
	/** Hard cap on the Jev call (jev-tier's 3s cap). */
	timeoutMs: number;
	minConfidence: number;
	/** How many trailing messages Jev sees. */
	messages: number;
	minToolCalls: number;
	/** Hard cap on the retro generation across the whole smol chain. */
	generateTimeoutMs: number;
}

export const DEFAULT_CONFIG: Config = {
	enabled: true,
	timeoutMs: 3000,
	minConfidence: 0.75,
	messages: 8,
	minToolCalls: 3,
	generateTimeoutMs: 60_000,
};

export function parseConfig(raw: unknown): Config {
	const out = { ...DEFAULT_CONFIG };
	if (!raw || typeof raw !== "object") return out;
	const r = raw as Record<string, unknown>;
	if (typeof r.enabled === "boolean") out.enabled = r.enabled;
	if (typeof r.timeoutMs === "number" && r.timeoutMs > 0 && r.timeoutMs <= 3000) out.timeoutMs = r.timeoutMs;
	if (typeof r.minConfidence === "number" && r.minConfidence >= 0 && r.minConfidence <= 1) out.minConfidence = r.minConfidence;
	if (typeof r.messages === "number" && Number.isInteger(r.messages) && r.messages >= 1 && r.messages <= 20) out.messages = r.messages;
	if (typeof r.minToolCalls === "number" && Number.isInteger(r.minToolCalls) && r.minToolCalls >= 0) out.minToolCalls = r.minToolCalls;
	if (typeof r.generateTimeoutMs === "number" && r.generateTimeoutMs >= 1000 && r.generateTimeoutMs <= 300_000) out.generateTimeoutMs = r.generateTimeoutMs;
	return out;
}

const OFF: Record<string, true> = { off: true, "0": true, false: true, no: true, disabled: true, disable: true };

export function isOff(env: Record<string, string | undefined>, config: Config): boolean {
	const v = env.OMP_AUTO_RETRO?.trim().toLowerCase();
	if (v !== undefined && OFF[v] === true) return true;
	return config.enabled === false;
}

// ---------------------------------------------------------------- session analysis

export interface TailMessage {
	role: "user" | "assistant" | "tool";
	text: string;
	tool?: string;
	error?: boolean;
}

export interface Facts {
	toolCalls: number;
	userTurns: number;
	/** A retro already ran: our own `retro` message, or a manual /retro. */
	retroRan: boolean;
	/** `none`, `plan`, `plan_paused`, `goal`, ... from the last `mode_change` entry. */
	mode: string;
	models: string[];
	efforts: string[];
	modelChanges: string[];
	last?: { id: string; role: string; stopReason?: string; text: string; hasToolCall: boolean };
	tail: TailMessage[];
	firstUser?: string;
	laterUser: string[];
	toolErrors: { tool: string; text: string }[];
	retries: number;
	/** omp's unexpected-stop classifier journaled a judgment after the final assistant message. */
	nativeStopCheck: boolean;
	/** Identifies this stop; the same key means the same final message. */
	key: string;
	/** Tool-call arguments as JSON (capped): which directories and repos the session worked in. */
	touched: string;
}

type Loose = Record<string, unknown>;

const isObj = (v: unknown): v is Loose => !!v && typeof v === "object";

function blocks(content: unknown): Loose[] {
	return Array.isArray(content) ? content.filter(isObj) : [];
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return blocks(content)
		.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
		.join("");
}

const oneLine = (text: string, max: number): string => {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const MANUAL_RETRO_RX = /^\s*\/(?:skill:)?retro\b/;

export function analyze(entries: readonly unknown[], messages = DEFAULT_CONFIG.messages): Facts {
	const facts: Facts = {
		toolCalls: 0,
		userTurns: 0,
		retroRan: false,
		mode: "none",
		models: [],
		efforts: [],
		modelChanges: [],
		tail: [],
		laterUser: [],
		toolErrors: [],
		retries: 0,
		nativeStopCheck: false,
		key: "",
		touched: "",
	};
	const models = new Set<string>();
	const efforts = new Set<string>();
	const convo: { index: number; entry: Loose; message: Loose }[] = [];
	let lastAssistantIndex = -1;
	let previousFailedTool: string | undefined;

	entries.forEach((raw, index) => {
		if (!isObj(raw)) return;
		const type = raw.type;
		if (type === "mode_change" && typeof raw.mode === "string") facts.mode = raw.mode;
		if (type === "custom_message" && raw.customType === "retro") facts.retroRan = true;
		// A manual retro: omp records `/skill:retro` as a `skill-prompt` custom message, never as user text.
		if (type === "custom_message" && raw.customType === "skill-prompt" && isObj(raw.details) && raw.details.name === "retro") facts.retroRan = true;
		if (type === "model_change" && typeof raw.model === "string") {
			facts.modelChanges.push(`${raw.model}${raw.resolvedModelIsFallback === true ? " (fallback)" : ""}`);
		}
		if (type === "thinking_level_change" && typeof raw.thinkingLevel === "string") efforts.add(raw.thinkingLevel);
		if (type === "model_usage" && raw.purpose === "unexpected-stop" && index > lastAssistantIndex && lastAssistantIndex >= 0) {
			facts.nativeStopCheck = true;
		}
		if (type !== "message" || !isObj(raw.message)) return;
		const message = raw.message;
		const role = message.role;

		if (role === "assistant") {
			lastAssistantIndex = index;
			facts.nativeStopCheck = false;
			if (typeof message.provider === "string" && typeof message.model === "string") models.add(`${message.provider}/${message.model}`);
			const effort = isObj(message.requestControls) && isObj(message.requestControls.effort) ? message.requestControls.effort.topLevel : undefined;
			if (typeof effort === "string") efforts.add(effort);
			for (const b of blocks(message.content)) {
				if (b.type !== "toolCall") continue;
				facts.toolCalls++;
				// Rolling tail: the repos the session ended up in matter more than the ones it opened with.
				facts.touched = `${facts.touched}${JSON.stringify(b.arguments ?? {}).slice(0, 600)}\n`.slice(-30_000);
			}
			convo.push({ index, entry: raw, message });
		} else if (role === "toolResult") {
			const tool = typeof message.toolName === "string" ? message.toolName : "tool";
			if (message.isError === true) {
				facts.toolErrors.push({ tool, text: oneLine(textOf(message.content), 160) });
				previousFailedTool = tool;
			} else {
				if (previousFailedTool === tool) facts.retries++; // same tool succeeded right after failing: a retry
				previousFailedTool = undefined;
			}
			convo.push({ index, entry: raw, message });
		} else if (role === "user" && message.attribution !== "agent") {
			const text = textOf(message.content);
			if (MANUAL_RETRO_RX.test(text)) facts.retroRan = true;
			facts.userTurns++;
			if (facts.firstUser === undefined) facts.firstUser = text;
			else facts.laterUser.push(text);
			convo.push({ index, entry: raw, message });
		}
	});

	facts.models = [...models];
	facts.efforts = [...efforts];

	const lastConvo = convo[convo.length - 1];
	if (lastConvo) {
		const m = lastConvo.message;
		facts.last = {
			id: typeof lastConvo.entry.id === "string" ? lastConvo.entry.id : String(lastConvo.index),
			role: typeof m.role === "string" ? m.role : "",
			stopReason: typeof m.stopReason === "string" ? m.stopReason : undefined,
			text: textOf(m.content),
			hasToolCall: blocks(m.content).some((b) => b.type === "toolCall"),
		};
		facts.key = facts.last.id;
	}
	for (const { message } of convo.slice(-messages)) {
		if (message.role === "toolResult") {
			facts.tail.push({ role: "tool", tool: typeof message.toolName === "string" ? message.toolName : "tool", error: message.isError === true, text: oneLine(textOf(message.content), 240) });
		} else if (message.role === "assistant" || message.role === "user") {
			facts.tail.push({ role: message.role, text: oneLine(textOf(message.content), 700) });
		}
	}
	return facts;
}

// A final message that asks the user something is blocked, not finished. Checked without a model:
// one of the last two non-empty prose lines ends in a question mark (code fences ignored).
export function endsWithQuestion(text: string): boolean {
	const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ");
	const lines = prose
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	return lines.slice(-2).some((line) => /\?[\s*_"'`)\]>]*$/.test(line));
}

// ---------------------------------------------------------------- pre-gates (no model call)

export interface GateInput {
	facts: Facts;
	config: Config;
	/** `ctx.agent.kind`; anything but "main" is a subagent (task, scout, reviewer, /tan clone). */
	agentKind: string | undefined;
	/** `ctx.mode`: retros only make sense in the TUI or an RPC host. */
	uiMode: string | undefined;
	willContinue: boolean;
	idle: boolean;
	hasPending: boolean;
	running: boolean;
	ran: boolean;
	judgedKey: string | undefined;
}

export function preGate(input: GateInput): string | undefined {
	const { facts, config } = input;
	if (input.agentKind !== "main") return "not the main session (subagent)";
	if (input.uiMode !== "tui" && input.uiMode !== "rpc") return `non-interactive mode (${input.uiMode ?? "unknown"})`;
	if (input.willContinue) return "agent will continue on its own";
	if (!input.idle || input.hasPending) return "agent busy or messages queued";
	if (facts.mode !== "none") return `session mode is ${facts.mode}`;
	if (input.ran || facts.retroRan) return "retro already ran this session";
	if (input.running) return "retro check already in flight";
	if (facts.toolCalls < config.minToolCalls) return `only ${facts.toolCalls} tool calls (< ${config.minToolCalls})`;
	const last = facts.last;
	if (!last || last.role !== "assistant") return "last message is not from the assistant";
	if (last.stopReason !== "stop") return `last turn ended with ${last.stopReason ?? "no stop reason"}`;
	if (last.hasToolCall) return "final message still has tool calls";
	if (!last.text.trim()) return "final message is empty";
	if (endsWithQuestion(last.text)) return "final message is a question to the user";
	if (input.judgedKey !== undefined && input.judgedKey === facts.key) return "this stop was already judged";
	return undefined;
}

// ---------------------------------------------------------------- git state

export interface ExecFn {
	(command: string, args: string[], options: { cwd: string; timeout: number }): Promise<{ stdout: string; code: number }>;
}

export interface GitFacts {
	repo: boolean;
	/** Directory the facts were read from. */
	dir: string;
	/** origin URL with any embedded credentials removed. */
	remote?: string;
	/** origin contains `your-work-org/`: a work repo with the Graphite/draft-PR rules. */
	work: boolean;
	branch?: string;
	dirty: number;
	head?: string;
}

/** Set OMP_WORK_ORG to the GitHub org that holds your work repos. */
const WORK_ORG = (process.env.OMP_WORK_ORG ?? "your-work-org").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const WORK_REMOTE_RX = new RegExp(`${WORK_ORG}/`, "i");

export const stripCredentials = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/i, "$1");

export async function readGit(exec: ExecFn, dir: string): Promise<GitFacts> {
	const run = async (args: string[]): Promise<{ out: string; ok: boolean }> => {
		try {
			const r = await exec("git", args, { cwd: dir, timeout: 3000 });
			return { out: r.stdout.trim(), ok: r.code === 0 };
		} catch {
			return { out: "", ok: false };
		}
	};
	const inside = await run(["rev-parse", "--is-inside-work-tree"]);
	if (!inside.ok || inside.out !== "true") return { repo: false, dir, work: false, dirty: 0 };
	const [remote, branch, status, head] = await Promise.all([
		run(["remote", "get-url", "origin"]),
		run(["branch", "--show-current"]),
		run(["status", "--porcelain"]),
		run(["rev-parse", "HEAD"]),
	]);
	return {
		repo: true,
		dir,
		// Test the raw URL (credentials never contain `your-work-org/`), publish the stripped one.
		remote: remote.ok ? stripCredentials(remote.out) : undefined,
		work: remote.ok && WORK_REMOTE_RX.test(remote.out),
		branch: branch.ok && branch.out ? branch.out : undefined,
		// An unreadable status counts as dirty: unknown is never "clean".
		dirty: status.ok ? status.out.split("\n").filter(Boolean).length : Number.POSITIVE_INFINITY,
		head: head.ok ? head.out : undefined,
	};
}

export interface GitView {
	/** The repo the retro is filed under: a work repo first, then the first repo. */
	primary: GitFacts;
	/** Every repo this session worked in. Empty when it did not work in one. */
	repos: GitFacts[];
}

const MAX_CHILD_REPOS = 12;

// Sessions often start in a directory that is not itself a repo (omp's "cwd outside git, direct-child repo"),
// so the work-repo rule has to follow the session into child repos. A child counts only when the session's
// tool calls mention its directory name, so an idle sibling checkout cannot veto a retro.
export async function readGitView(exec: ExecFn, cwd: string, touched = ""): Promise<GitView> {
	const own = await readGit(exec, cwd);
	let repos: GitFacts[] = own.repo ? [own] : [];
	if (!own.repo) {
		let names: string[] = [];
		try {
			names = readdirSync(cwd, { withFileTypes: true })
				.filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(cwd, d.name, ".git")) && touched.includes(d.name))
				.map((d) => d.name)
				.slice(0, MAX_CHILD_REPOS);
		} catch {
			names = [];
		}
		repos = (await Promise.all(names.map((name) => readGit(exec, join(cwd, name))))).filter((r) => r.repo);
	}
	return { primary: repos.find((r) => r.work) ?? repos[0] ?? own, repos };
}

// Work repos only: "finished" needs a clean committed tree and a submitted draft PR (`gt submit --draft`)
// whose head is the commit we are on. Read-only: `gh pr view`. Returns the reason it is not ready.
export async function workRepoBlocker(git: GitFacts, exec: ExecFn): Promise<string | undefined> {
	if (git.dirty > 0) return "work repo: uncommitted changes";
	if (!git.head) return "work repo: HEAD unreadable";
	let stdout: string;
	try {
		const r = await exec("gh", ["pr", "view", "--json", "number,state,isDraft,headRefOid"], { cwd: git.dir, timeout: 8000 });
		if (r.code !== 0) return "work repo: no PR for this branch";
		stdout = r.stdout;
	} catch {
		return "work repo: PR state unreadable";
	}
	let pr: unknown;
	try {
		pr = JSON.parse(stdout);
	} catch {
		return "work repo: PR state unreadable";
	}
	if (!isObj(pr)) return "work repo: PR state unreadable";
	if (pr.state !== "OPEN") return "work repo: PR is not open";
	if (pr.isDraft !== true) return "work repo: PR is not a draft";
	if (pr.headRefOid !== git.head) return "work repo: latest commit not submitted";
	return undefined;
}

// ---------------------------------------------------------------- Jev

export type Verdict = "finished" | "blocked_on_user" | "mid_task" | "abandoned";

export const VERDICTS: readonly Verdict[] = ["finished", "blocked_on_user", "mid_task", "abandoned"];

export function stopQuestion(): ChoiceQuestion {
	return {
		type: "choice",
		instructions:
			"Is this coding session finished? Read the end of `last_messages`, `git` and `omp_stop_check`. Choose finished only when the user's request is done and nothing remains for the assistant or the user. A final message that asks the user anything or waits on them is blocked_on_user. Steps still to do, failing checks or unresolved tool errors are mid_task. A cancelled, dropped or switched-away task is abandoned. When unsure, never choose finished.",
		criteria: {
			finished: rubric(
				"The request is fulfilled, the final message reports the result, and nothing is pending. Checks passed or were not needed.",
				["I fixed the bug, tests pass, committed on branch x", "Done: the skill is written and the file exists", "Here is the summary you asked for"],
				"A message that ends with a question, a next step the assistant still owns, or a failing check.",
			),
			blocked_on_user: rubric(
				"The assistant needs an answer, a decision, approval, a credential or a manual step from the user before it can go on.",
				["Which of these two options do you prefer?", "I need your approval before deleting the table", "Run this command yourself and paste the output"],
				"A finished report that merely offers further help.",
			),
			mid_task: rubric(
				"The assistant stopped with work left: announced next steps, failing tests or builds, unresolved tool errors, a half-applied change.",
				["Next I will update the callers", "3 tests still fail", "The last edit failed and was not retried"],
				"A complete result, or a question waiting on the user.",
			),
			abandoned: rubric(
				"The user cancelled or dropped the task, switched topic, or the attempt was given up without a result.",
				["Never mind, forget it", "The user interrupted and moved to another subject", "I could not do this and stopped"],
				"Work that reached its goal, or work paused for the user's input.",
			),
		},
	};
}

export interface StopState {
	last_messages: TailMessage[];
	tool_calls: number;
	user_turns: number;
	tool_errors: number;
	git: { repo: boolean; work_repo: boolean; branch?: string; uncommitted_files: number | "unknown" };
	omp_stop_check: string;
}

export function stopState(facts: Facts, view: GitView, secrets: string[] = []): StopState {
	const git = view.primary;
	return {
		last_messages: facts.tail.map((m) => ({ ...m, text: redact(m.text, secrets) })),
		tool_calls: facts.toolCalls,
		user_turns: facts.userTurns,
		tool_errors: facts.toolErrors.length,
		git: {
			repo: git.repo,
			work_repo: view.repos.some((r) => r.work),
			branch: git.branch,
			uncommitted_files: Number.isFinite(view.repos.reduce((n, r) => n + r.dirty, 0)) ? view.repos.reduce((n, r) => n + r.dirty, 0) : "unknown",
		},
		// omp's own unexpected-stop classifier (features.unexpectedStopDetection: smart) judges a stop before
		// settle and retries when it looks unintended. Reaching agent_end after it ran means it ruled the stop
		// deliberate; its verdict is carried in rather than asked again.
		omp_stop_check: facts.nativeStopCheck ? "omp judged this stop deliberate (not an early stop)" : "not run",
	};
}

export interface StopVerdict {
	verdict: Verdict;
	confidence: number;
}

export async function judgeStop(judge: JudgeFn, state: StopState, config: Config): Promise<StopVerdict> {
	const answer = await askChoice({
		judge,
		state: state as unknown as Record<string, unknown>,
		questionId: "session_state",
		question: stopQuestion(),
		choices: VERDICTS,
		purpose: "auto-retro:session_state",
		timeoutMs: config.timeoutMs,
	});
	return { verdict: answer.choice, confidence: Math.round(answer.confidence * 1000) / 1000 };
}

// ---------------------------------------------------------------- retro text

export function skillBody(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

export function retroSystem(skill: string): string {
	return `${skillBody(skill)}\n\n## Harness\n\nThe harness writes the file and its header. Output only the report: the two sections, nothing before or after. You have no tools; use only the session digest you are given.`;
}

export interface RetroMeta {
	repo: string;
	branch: string;
	sessionId: string;
	models: string[];
}

export function retroPrompt(facts: Facts, meta: RetroMeta, secrets: string[] = []): string {
	const clean = (text: string, max: number): string => redact(oneLine(text, max), secrets);
	const lines: string[] = [
		`repo: ${meta.repo}`,
		`branch: ${meta.branch}`,
		`models used: ${meta.models.join(", ") || "unknown"}`,
		`efforts seen: ${facts.efforts.join(", ") || "unknown"}`,
		`tool calls: ${facts.toolCalls}, tool failures: ${facts.toolErrors.length}, retries after failure: ${facts.retries}, user turns: ${facts.userTurns}`,
	];
	if (facts.modelChanges.length > 0) lines.push(`model changes: ${facts.modelChanges.slice(0, 10).join(" -> ")}`);
	if (facts.firstUser !== undefined) lines.push("", "Opening request:", clean(facts.firstUser, 600));
	if (facts.laterUser.length > 0) {
		lines.push("", "Later user messages (watch for repeated corrections):");
		facts.laterUser.slice(-15).forEach((t, i) => lines.push(`${i + 1}. ${clean(t, 240)}`));
	}
	if (facts.toolErrors.length > 0) {
		lines.push("", "Tool failures:");
		for (const e of facts.toolErrors.slice(-12)) lines.push(`- ${e.tool}: ${clean(e.text, 160)}`);
	}
	if (facts.last) lines.push("", "Final assistant message:", clean(facts.last.text, 1200));
	return lines.join("\n");
}

export function localDate(now: Date): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function retroEntry(now: Date, meta: RetroMeta, report: string, retroModel: string): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return [
		`## ${p(now.getHours())}:${p(now.getMinutes())}`,
		"",
		`- repo: ${meta.repo}`,
		`- branch: ${meta.branch}`,
		`- session: ${meta.sessionId}`,
		`- models: ${meta.models.join(", ") || "unknown"}`,
		`- retro: auto, ${retroModel}`,
		"",
		report.trim(),
		"",
		"---",
		"",
		"",
	].join("\n");
}

// Appends to <dir>/YYYY-MM-DD.md and returns the file path. Never overwrites.
export function appendRetro(dir: string, now: Date, entry: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${localDate(now)}.md`);
	appendFileSync(file, entry, { encoding: "utf8", mode: 0o600 });
	return file;
}

export function formatLog(sessionId: string, action: "run" | "skip", reason: string, extra: { verdict?: string; confidence?: number } = {}, now = new Date()): string {
	return [
		now.toISOString(),
		`session=${sessionId.slice(0, 8)}`,
		`verdict=${extra.verdict ?? "-"}`,
		`conf=${extra.confidence ?? "-"}`,
		`action=${action === "run" ? "ran" : "skipped"}`,
		`reason=${JSON.stringify(reason)}`,
	].join(" ");
}
