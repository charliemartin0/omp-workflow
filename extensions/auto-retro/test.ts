// Mocked harness for auto-retro: drives the real hook handlers from register.ts with a scripted Jev judge, a
// scripted smol generator and a fake git/gh. No network, no model. Writes under a temp dir, never to ~/.omp.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JudgeRequest } from "../jev-tier/core";
import { DEFAULT_CONFIG, analyze, endsWithQuestion, isOff, parseConfig, stripCredentials } from "./core";
import { register, type Dependencies, type ExtensionContext, type Generated, type Handle } from "./register";

const skillPath = join(process.env.HOME ?? "", ".omp", "agent", "skills", "retro", "SKILL.md");
const when = new Date(2026, 9, 7, 9, 41); // local time, so the file name matches localDate()

// ---------------------------------------------------------------- session fixtures

let seq = 0;
const id = (): string => `e${++seq}`;
const user = (text: string) => ({ type: "message", id: id(), message: { role: "user", attribution: "user", content: [{ type: "text", text }] } });
const call = (tool: string) => ({
	type: "message",
	id: id(),
	message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", stopReason: "toolUse", requestControls: { effort: { topLevel: "high" } }, content: [{ type: "toolCall", id: `c${seq}`, name: tool, arguments: {} }] },
});
const result = (tool: string, isError = false, text = "ok") => ({ type: "message", id: id(), message: { role: "toolResult", toolName: tool, isError, content: [{ type: "text", text }] } });
const final = (text: string, stopReason = "stop") => ({
	type: "message",
	id: id(),
	message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", stopReason, content: [{ type: "text", text }] },
});

// Fake credentials, split so secret scanners do not flag the fixtures.
const FAKE_SK = ["sk", "live1234567890abcdefXYZ"].join("-");
const FAKE_GHS = ["ghs", "abcdefghijklmnop1234"].join("_");

function finishedEntries(finalText = "Fixed the pagination bug. Tests pass and the change is committed on feat/pagination.") {
	return [
		user("Fix the off-by-one in the pagination helper"),
		call("grep"),
		result("grep"),
		call("edit"),
		result("edit", true, "edit failed: stale tag"),
		call("edit"),
		result("edit"),
		final(finalText),
	];
}

const callWith = (tool: string, args: Record<string, unknown>) => ({
	type: "message",
	id: id(),
	message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", stopReason: "toolUse", content: [{ type: "toolCall", id: `c${seq}`, name: tool, arguments: args }] },
});

// ---------------------------------------------------------------- harness

interface Script {
	choice?: string;
	confidence?: number;
	judgeFails?: boolean;
	generateFails?: boolean;
	/** Hold generation until the test releases it (or the signal aborts). */
	hold?: boolean;
	remote?: string;
	dirty?: string;
	head?: string;
	pr?: string | null;
	prThrows?: boolean;
	config?: unknown;
	/** Hold the Jev call until `releaseJudge()`. */
	holdJudge?: boolean;
	/** The session cwd is not itself a repo; `child` names a direct-child directory that is. */
	notRepoAtCwd?: boolean;
	child?: string;
}

function harness(entries: unknown[], script: Script = {}, overrides: Partial<ExtensionContext> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "auto-retro-"));
	const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
	const sent: { customType: string; content: string; details?: unknown }[] = [];
	const notifications: string[] = [];
	const judged: JudgeRequest[] = [];
	const generated: { system: string; prompt: string }[] = [];
	const execs: string[] = [];
	let release: (() => void) | undefined;
	let idle = true;
	let sessionId = "01a1154f-669a-7266-8606-512258ab1eba";
	const judgeGate = Promise.withResolvers<void>();

	const configPath = join(dir, "config.json");
	if (script.config !== undefined) Bun.write(configPath, JSON.stringify(script.config));
	if (script.child) mkdirSync(join(dir, script.child, ".git"), { recursive: true });

	const deps: Dependencies = {
		judge: async (_context, request) => {
			judged.push(request);
			if (script.holdJudge) await judgeGate.promise;
			assert.equal(Object.keys(request.questions).length, 1, "one question per judgment");
			const [question] = Object.values(request.questions);
			assert.equal(question.type, "choice");
			assert.equal(typeof question.instructions, "string");
			assert.deepEqual(Object.keys(question.criteria), ["finished", "blocked_on_user", "mid_task", "abandoned"]);
			assert.ok(Object.values(question.criteria).every((label) => typeof label === "string" && label.length > 0));
			assert.ok(request.purpose.startsWith("auto-retro:"));
			if (script.judgeFails) throw new Error("key rejected (401)");
			const choice = script.choice ?? "finished";
			const confidence = script.confidence ?? 0.93;
			return { answers: { session_state: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence } } };
		},
		generate: async (_context, request): Promise<Generated> => {
			generated.push({ system: request.system, prompt: request.prompt });
			if (script.generateFails) throw new Error("every smol candidate failed");
			if (script.hold) {
				script.hold = false; // one-shot: a later generation on the same harness runs normally
				const gate = Promise.withResolvers<void>();
				release = gate.resolve;
				request.signal.addEventListener("abort", () => gate.reject(new Error("aborted")));
				await gate.promise;
			}
			return { text: "### What went well\n- Found the bug fast.\n\n### Even better if\n- edit failed on a stale tag -> **fix** `skill` re-read before editing", model: "openai-codex/gpt-6-luna" };
		},
		exec: async (command, args, options) => {
			const line = `${command} ${args.join(" ")}`;
			execs.push(line);
			const ok = (stdout: string) => ({ stdout, code: 0 });
			if (line === "git rev-parse --is-inside-work-tree") return script.notRepoAtCwd && options.cwd === dir ? { stdout: "", code: 128 } : ok("true\n");
			if (line === "git remote get-url origin") return ok(`${script.remote ?? "git@github.com:user/dotfiles.git"}\n`);
			if (line === "git branch --show-current") return ok("feat/pagination\n");
			if (line === "git status --porcelain") return ok(script.dirty ?? "");
			if (line === "git rev-parse HEAD") return ok(`${script.head ?? "abc123"}\n`);
			if (command === "gh") {
				if (script.prThrows) throw new Error("gh not installed");
				if (script.pr === null || script.pr === undefined) return { stdout: "", code: 1 };
				return ok(script.pr);
			}
			throw new Error(`unexpected exec: ${line}`);
		},
		readSkill: () => readFileSync(skillPath, "utf8"),
		now: () => when,
		retroDir: join(dir, "retros"),
		logPath: join(dir, "auto-retro.log"),
		configPath,
		idleWaitMs: 400,
	};

	const pi = {
		on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => void handlers.set(event, handler),
		sendMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }) => {
			sent.push(message);
			// omp persists a delivered custom message as a custom_message entry on the branch.
			entries.push({ type: "custom_message", id: id(), customType: message.customType, content: message.content });
		},
	};
	const handle = register(pi, deps);

	const context: ExtensionContext & { ui: { notify(message: string): void } } = {
		mode: "tui",
		cwd: dir,
		agent: { kind: "main" },
		isIdle: () => idle,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		ui: { notify: (message) => void notifications.push(message) },
		...overrides,
	};

	return {
		sent,
		notifications,
		judged,
		generated,
		execs,
		handle,
		dir,
		setIdle: (value: boolean) => void (idle = value),
		release: () => release?.(),
		releaseJudge: () => judgeGate.resolve(),
		/** `/new` or `/resume`: the same AgentSession now holds a different session. */
		switchSession: (next: string) => {
			handlers.get("session_before_switch")?.({}, context);
			sessionId = next;
		},
		entries,
		idle: (event: unknown = {}) => void handlers.get("agent_end")?.(event, context),
		start: () => void handlers.get("agent_start")?.({}, context),
		log: () => (existsSync(deps.logPath ?? "") ? readFileSync(deps.logPath ?? "", "utf8").trim().split("\n") : []),
		retroFiles: () => (existsSync(join(dir, "retros")) ? readdirSync(join(dir, "retros")) : []),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

interface Settleable {
	idle(event?: unknown): void;
	handle: Handle;
}

async function idleAndSettle(h: Settleable, event: unknown = {}): Promise<void> {
	h.idle(event);
	await h.handle.settled();
}

// ---------------------------------------------------------------- the five requested cases

async function finishedRunsOnce(): Promise<void> {
	const h = harness(finishedEntries());
	await idleAndSettle(h);
	assert.equal(h.sent.length, 1, "one retro message");
	assert.equal(h.judged.length, 1, "one Jev call");
	assert.equal(h.generated.length, 1, "one generation");
	assert.equal(h.sent[0].customType, "retro");
	assert.match(h.sent[0].content, /What went well/);
	assert.deepEqual(h.retroFiles(), ["2026-10-07.md"]);
	const file = readFileSync(join(h.dir, "retros", "2026-10-07.md"), "utf8");
	assert.match(file, /^## 09:41\n/);
	assert.match(file, /- repo: git@github\.com:user\/dotfiles\.git\n/);
	assert.match(file, /- branch: feat\/pagination\n/);
	assert.match(file, /- session: 01a1154f-669a-7266-8606-512258ab1eba\n/);
	assert.match(file, /- models: anthropic\/claude-sonnet-5-5\n/);
	assert.match(file, /- retro: auto, openai-codex\/gpt-6-luna\n/);
	assert.match(file, /### Even better if/);
	// The prompt is the real skill body, minus frontmatter, plus the harness note, and the digest has the friction.
	assert.ok(!h.generated[0].system.includes("name: retro"), "frontmatter stripped");
	assert.match(h.generated[0].system, /## Fix tags/);
	assert.match(h.generated[0].system, /Output only the report/);
	assert.match(h.generated[0].prompt, /tool failures: 1, retries after failure: 1/);
	assert.match(h.generated[0].prompt, /edit: edit failed: stale tag/);
	assert.match(h.generated[0].prompt, /efforts seen: high/);
	assert.equal(h.notifications.length, 0, "no UI chatter");
	const [line] = h.log();
	assert.match(line, /action=ran/);
	h.cleanup();
	console.log("PASS fake finished session: retro runs once, file + message written, skill body used as prompt");
}

async function midTaskSkipped(): Promise<void> {
	const h = harness(finishedEntries("Edited two of the three callers. Next I will update the last caller."), { choice: "mid_task", confidence: 0.96 });
	await idleAndSettle(h);
	assert.equal(h.judged.length, 1, "Jev was asked");
	assert.equal(h.generated.length, 0);
	assert.equal(h.sent.length, 0);
	assert.deepEqual(h.retroFiles(), []);
	assert.match(h.log()[0], /verdict=mid_task .*action=skipped .*jev says mid_task/);
	// Same for the other non-finished verdicts, and for a finished verdict below the confidence bar.
	for (const [choice, confidence] of [["blocked_on_user", 0.99], ["abandoned", 0.99], ["finished", 0.6]] as const) {
		const other = harness(finishedEntries(), { choice, confidence });
		await idleAndSettle(other);
		assert.equal(other.sent.length, 0, `${choice}@${confidence}`);
		assert.equal(other.generated.length, 0, `${choice}@${confidence}`);
		other.cleanup();
	}
	h.cleanup();
	console.log("PASS mid-task session skipped (also blocked_on_user, abandoned, finished below 0.75)");
}

async function questionSkippedWithoutModel(): Promise<void> {
	for (const text of ["I can do it two ways. Which do you prefer?", "Done with the refactor.\n\nWant me to open the PR now?", "All set. Shall I continue?**"]) {
		const h = harness(finishedEntries(text));
		await idleAndSettle(h);
		assert.equal(h.judged.length, 0, `no Jev call for: ${text}`);
		assert.equal(h.execs.length, 0, "no git either");
		assert.equal(h.sent.length, 0);
		assert.match(h.log()[0], /final message is a question/);
		h.cleanup();
	}
	// Question marks inside code fences or mid-sentence do not count.
	assert.equal(endsWithQuestion("Result:\n```\nSELECT a ? b\n```\nDone."), false);
	assert.equal(endsWithQuestion("Is that a bug? No. It is by design."), false);
	console.log("PASS session ending in a question skipped before any Jev or git call");
}

async function jevDownQuiet(): Promise<void> {
	const h = harness(finishedEntries(), { judgeFails: true });
	await idleAndSettle(h);
	assert.equal(h.sent.length, 0);
	assert.equal(h.generated.length, 0);
	assert.equal(h.notifications.length, 0, "no UI error spam");
	assert.equal(h.log().length, 1);
	assert.match(h.log()[0], /action=skipped .*jev error: key rejected \(401\)/);
	// The same stop is not re-judged on a repeat idle, so a dead Jev is hit once, not once per notification.
	await idleAndSettle(h);
	await idleAndSettle(h);
	assert.equal(h.judged.length, 1, "Jev called once for this stop");
	assert.equal(h.log().length, 3);
	assert.ok(h.log().slice(1).every((l) => /this stop was already judged/.test(l)));
	// A later, different stop gets a fresh try once Jev is back.
	h.cleanup();
	console.log("PASS Jev down: skipped, one log line, no UI notifications, no repeat calls");
}

async function twoIdlesOneRetro(): Promise<void> {
	// Back to back with no await in between: the second arrives while the first is in flight.
	const h = harness(finishedEntries());
	h.idle();
	h.idle();
	await h.handle.settled();
	assert.equal(h.sent.length, 1);
	assert.equal(h.generated.length, 1);
	assert.equal(h.judged.length, 1);
	// A third idle after completion: the session is marked, the branch has the retro message.
	await idleAndSettle(h);
	assert.equal(h.sent.length, 1);
	assert.equal(h.judged.length, 1);
	const file = readFileSync(join(h.dir, "retros", "2026-10-07.md"), "utf8");
	assert.equal(file.match(/^## /gm)?.length, 1, "one entry in the day file");
	assert.match(h.log().join("\n"), /retro check already in flight/);
	assert.match(h.log().join("\n"), /retro already ran this session/);
	h.cleanup();
	console.log("PASS two idles in a row (concurrent, then after): exactly one retro");
}

// ---------------------------------------------------------------- gates and edges

async function preGates(): Promise<void> {
	const cases: [string, unknown[], Partial<ExtensionContext>, unknown, RegExp][] = [
		["fewer than 3 tool calls", [user("hi"), call("read"), result("read"), final("Here it is.")], {}, {}, /only 1 tool calls/],
		["subagent", finishedEntries(), { agent: { kind: "sub" } }, {}, /subagent/],
		["plan mode", [{ type: "mode_change", id: id(), mode: "plan" }, ...finishedEntries()], {}, {}, /session mode is plan/],
		["plan paused", [{ type: "mode_change", id: id(), mode: "plan_paused" }, ...finishedEntries()], {}, {}, /session mode is plan_paused/],
		["plan mode exited", [{ type: "mode_change", id: id(), mode: "plan" }, { type: "mode_change", id: id(), mode: "none" }, ...finishedEntries()], {}, { expectRun: true }, /action=ran/],
		["print mode", finishedEntries(), { mode: "print" }, {}, /non-interactive mode \(print\)/],
		["will continue", finishedEntries(), {}, { willContinue: true }, /will continue/],
		["aborted turn", [...finishedEntries().slice(0, -1), final("Partial", "aborted")], {}, {}, /ended with aborted/],
		["manual /skill:retro earlier", [{ type: "custom_message", id: id(), customType: "skill-prompt", details: { name: "retro" }, content: "# Retro ..." }, ...finishedEntries()], {}, {}, /already ran/],
		["other skill earlier does not count", [{ type: "custom_message", id: id(), customType: "skill-prompt", details: { name: "graphite" }, content: "..." }, ...finishedEntries()], {}, { expectRun: true }, /action=ran/],
		["busy", finishedEntries(), { isIdle: () => false }, {}, /busy/],
		["last message is a tool result", [...finishedEntries(), call("bash"), result("bash")], {}, {}, /not from the assistant/],
	];
	for (const [name, entries, overrides, event, expected] of cases) {
		const h = harness(entries, {}, overrides);
		const { expectRun, ...agentEnd } = event as { expectRun?: boolean; willContinue?: boolean };
		await idleAndSettle(h, agentEnd);
		assert.match(h.log()[0] ?? "", expected, name);
		if (!expectRun) {
			assert.equal(h.judged.length, 0, `${name}: no Jev call`);
			assert.equal(h.execs.length, 0, `${name}: no git call`);
			assert.equal(h.sent.length, 0, name);
		}
		h.cleanup();
	}
	console.log("PASS pre-gates: <3 tool calls, subagent, plan/plan_paused, print mode, willContinue, aborted, manual /retro, busy; none cost a model call");
}

async function killSwitch(): Promise<void> {
	process.env.OMP_AUTO_RETRO = "0";
	const envOff = harness(finishedEntries());
	await idleAndSettle(envOff);
	assert.equal(envOff.judged.length + envOff.sent.length + envOff.execs.length, 0);
	assert.equal(envOff.log().length, 0, "off means silent");
	envOff.cleanup();
	delete process.env.OMP_AUTO_RETRO;

	const cfgOff = harness(finishedEntries(), { config: { enabled: false } });
	await Bun.sleep(5); // Bun.write in the harness is async
	await idleAndSettle(cfgOff);
	assert.equal(cfgOff.judged.length + cfgOff.sent.length + cfgOff.execs.length, 0);
	cfgOff.cleanup();

	assert.equal(isOff({ OMP_AUTO_RETRO: "off" }, DEFAULT_CONFIG), true);
	assert.equal(isOff({ OMP_AUTO_RETRO: "1" }, DEFAULT_CONFIG), false);
	assert.equal(isOff({}, DEFAULT_CONFIG), false);
	assert.equal(parseConfig({ enabled: false }).enabled, false);
	assert.equal(parseConfig({ timeoutMs: 99_999 }).timeoutMs, 3000, "Jev cap cannot be raised past 3s");
	console.log("PASS kill switch: OMP_AUTO_RETRO=0 and config.json enabled=false");
}

async function workRepoRules(): Promise<void> {
	const remote = "git@github.com-work:your-work-org/work-app.git";
	const draft = (headRefOid: string, extra = {}) => JSON.stringify({ number: 412, state: "OPEN", isDraft: true, headRefOid, ...extra });
	const cases: [string, Script, RegExp][] = [
		["dirty tree", { remote, dirty: " M src/a.ts\n", pr: draft("abc123") }, /work repo: uncommitted changes/],
		["no PR", { remote, pr: null }, /no PR for this branch/],
		["PR not draft", { remote, pr: draft("abc123", { isDraft: false }) }, /PR is not a draft/],
		["PR behind HEAD", { remote, pr: draft("old999") }, /latest commit not submitted/],
		["PR closed", { remote, pr: draft("abc123", { state: "MERGED" }) }, /PR is not open/],
		["gh missing", { remote, prThrows: true }, /PR state unreadable/],
	];
	for (const [name, script, expected] of cases) {
		const h = harness(finishedEntries(), script);
		await idleAndSettle(h);
		assert.equal(h.sent.length, 0, name);
		assert.equal(h.generated.length, 0, name);
		assert.match(h.log()[0], expected, name);
		h.cleanup();
	}
	const ok = harness(finishedEntries(), { remote, pr: draft("abc123") });
	await idleAndSettle(ok);
	assert.equal(ok.sent.length, 1, "clean tree + submitted draft PR at HEAD: retro runs");
	assert.ok(ok.execs.some((e) => e.startsWith("gh pr view")));
	ok.cleanup();
	// Personal repos never touch gh and ignore a dirty tree.
	const personal = harness(finishedEntries(), { dirty: " M notes.md\n" });
	await idleAndSettle(personal);
	assert.equal(personal.sent.length, 1);
	assert.ok(!personal.execs.some((e) => e.startsWith("gh ")));
	personal.cleanup();
	console.log("PASS work repo: needs clean tree + open draft PR at HEAD; personal repo skips the PR check");
}

async function userContinuesMidRetro(): Promise<void> {
	const entries = finishedEntries();
	const h = harness(entries, { hold: true });
	h.idle();
	await Bun.sleep(20); // let it reach generation
	assert.equal(h.generated.length, 1);
	h.start(); // the user typed something: a new turn began
	await h.handle.settled();
	assert.equal(h.sent.length, 0, "no retro over a resumed session");
	assert.deepEqual(h.retroFiles(), []);
	// Same register instance, later stop (a new final message): the abort did not mark the session as done.
	entries.push(user("also add a test"), final("Added the test. All green."));
	await idleAndSettle(h);
	assert.equal(h.sent.length, 1, "the next finished stop still gets its retro");
	h.cleanup();
	console.log("PASS user resumes mid-retro: generation aborted, nothing appended, no permanent mark");
}

// /new and /resume switch the session in place: no agent_start, no shutdown. A retro still on Jev must not land
// in the other session.
async function sessionSwitchedMidRetro(): Promise<void> {
	const entries = finishedEntries();
	const h = harness(entries, { holdJudge: true });
	h.idle();
	await Bun.sleep(30); // let it reach Jev
	assert.equal(h.judged.length, 1);
	h.switchSession("01a1ffff-0000-7000-8000-000000000000");
	h.releaseJudge();
	await h.handle.settled();
	assert.equal(h.sent.length, 0, "no retro delivered into the new session");
	assert.equal(h.generated.length, 0);
	assert.deepEqual(h.retroFiles(), []);
	assert.match(h.log()[0], /a new turn started/);
	h.cleanup();
	console.log("PASS /new or /resume while Jev is in flight: retro dropped, not delivered into the other session");
}

// Turn 1 stops and its check is still on Jev; the user sends a short follow-up and turn 2 ends too. Stop 2 must
// not be dropped as "already in flight".
async function followUpStopWhileCheckInFlight(): Promise<void> {
	const entries = finishedEntries();
	const h = harness(entries, { holdJudge: true });
	h.idle();
	await Bun.sleep(30);
	assert.equal(h.judged.length, 1);
	h.start(); // turn 2 begins
	entries.push(user("rename it"), final("Renamed. Done."));
	h.idle(); // turn 2 ends while check 1 is still waiting
	await Bun.sleep(30);
	h.releaseJudge();
	await h.handle.settled();
	assert.equal(h.sent.length, 1, "exactly one retro, for the later stop");
	assert.equal(h.judged.length, 2, "check 1 judged, then stop 2 judged");
	assert.ok(!h.log().some((l) => /already in flight/.test(l)), "stop 2 was not dropped as in flight");
	h.cleanup();
	console.log("PASS follow-up stop while an earlier check is in flight: judged after it, one retro");
}

// A session started in a directory that is not a repo (omp's "cwd outside git, direct-child repo") still gets the
// work-repo rule for the child repo it worked in.
async function workRepoInChildDirectory(): Promise<void> {
	const remote = "git@github.com-work:your-work-org/work-lib.git";
	const touching = (entries: unknown[]) => [callWith("read", { path: "work-lib/src/a.ts" }), ...entries];
	const dirty = harness(touching(finishedEntries()), { remote, notRepoAtCwd: true, child: "work-lib", dirty: " M src/a.ts\n" });
	await idleAndSettle(dirty);
	assert.equal(dirty.sent.length, 0);
	assert.match(dirty.log()[0], /work repo: uncommitted changes/);
	dirty.cleanup();

	const noPr = harness(touching(finishedEntries()), { remote, notRepoAtCwd: true, child: "work-lib", pr: null });
	await idleAndSettle(noPr);
	assert.equal(noPr.sent.length, 0);
	assert.match(noPr.log()[0], /no PR for this branch/);
	noPr.cleanup();

	// A child repo reached only after a long run of unrelated tool calls is still seen (rolling tail, not first 30k).
	const filler = Array.from({ length: 80 }, (_, i) => callWith("bash", { command: `echo ${"x".repeat(500)} ${i}` }));
	const late = harness([...filler, ...touching(finishedEntries())], { remote, notRepoAtCwd: true, child: "work-lib", dirty: " M src/a.ts\n" });
	await idleAndSettle(late);
	assert.equal(late.sent.length, 0);
	assert.match(late.log()[0], /work repo: uncommitted changes/);
	late.cleanup();

	// A child repo the session never touched cannot veto the retro.
	const untouched = harness(finishedEntries(), { remote, notRepoAtCwd: true, child: "work-lib", dirty: " M src/a.ts\n" });
	await idleAndSettle(untouched);
	assert.equal(untouched.sent.length, 1);
	assert.ok(!untouched.execs.some((e) => e.startsWith("gh ")));
	untouched.cleanup();
	console.log("PASS work repo in a child directory: dirty or PR-less child blocks the retro; an untouched child does not");
}

async function credentialsStripped(): Promise<void> {
	const h = harness(finishedEntries(), { remote: `https://x-access-token:${FAKE_GHS}@github.com/user/notes.git` });
	await idleAndSettle(h);
	assert.equal(h.sent.length, 1);
	const file = readFileSync(join(h.dir, "retros", "2026-10-07.md"), "utf8");
	assert.match(file, /- repo: https:\/\/github\.com\/user\/notes\.git\n/);
	assert.ok(!file.includes("ghs_abcdefgh"));
	assert.ok(!h.generated[0].prompt.includes("ghs_abcdefgh"));
	assert.equal(stripCredentials("git@github.com:a/b.git"), "git@github.com:a/b.git");
	h.cleanup();
	console.log("PASS origin URL credentials stripped before the model prompt and the day file");
}

// omp emits agent_end from inside the settle path, before isStreaming clears: the first isIdle() calls say busy.
async function lateIdle(): Promise<void> {
	let busyPolls = 3;
	const lateFlip = harness(finishedEntries(), {}, { isIdle: () => --busyPolls < 0 });
	await idleAndSettle(lateFlip);
	assert.equal(lateFlip.sent.length, 1, "idle flips 150ms after agent_end: retro still runs");
	lateFlip.cleanup();

	const never = harness(finishedEntries(), {}, { isIdle: () => false });
	await idleAndSettle(never);
	assert.equal(never.judged.length, 0);
	assert.match(never.log()[0], /agent busy or messages queued/);
	never.cleanup();

	const resumed = harness(finishedEntries(), {}, { isIdle: () => false });
	resumed.idle();
	await Bun.sleep(100);
	resumed.start(); // a new turn begins while we wait for idle
	await resumed.handle.settled();
	assert.equal(resumed.judged.length, 0);
	assert.match(resumed.log()[0], /a new turn started/);
	resumed.cleanup();
	console.log("PASS late idle: waits briefly for isIdle (as omp reports it), gives up when busy, drops on a new turn");
}

async function generationFailureGivesUp(): Promise<void> {
	const h = harness(finishedEntries(), { generateFails: true });
	await idleAndSettle(h);
	assert.equal(h.sent.length, 0);
	assert.match(h.log()[0], /retro generation failed: every smol candidate failed/);
	assert.equal(h.notifications.length, 0);
	// Later idles do not retry (and so do not pay for Jev again).
	await idleAndSettle(h);
	assert.equal(h.generated.length, 1);
	assert.equal(h.judged.length, 1);
	h.cleanup();
	console.log("PASS generation failure: one log line, no retry, no UI");
}

async function analysis(): Promise<void> {
	const facts = analyze([...finishedEntries(), { type: "model_usage", id: id(), purpose: "unexpected-stop" }]);
	assert.equal(facts.toolCalls, 3);
	assert.equal(facts.userTurns, 1);
	assert.equal(facts.toolErrors.length, 1);
	assert.equal(facts.retries, 1);
	assert.deepEqual(facts.models, ["anthropic/claude-sonnet-5-5"]);
	assert.equal(facts.nativeStopCheck, true, "omp's unexpected-stop judgment after the final message is carried in");
	const before = analyze([{ type: "model_usage", id: id(), purpose: "unexpected-stop" }, ...finishedEntries()]);
	assert.equal(before.nativeStopCheck, false, "a judgment from an earlier stop does not count");
	const h = harness([...finishedEntries(), { type: "model_usage", id: id(), purpose: "unexpected-stop" }]);
	await idleAndSettle(h);
	assert.equal(h.judged.length, 1);
	assert.match(JSON.stringify(h.judged[0].state), /omp judged this stop deliberate/);
	// Secrets never reach Jev.
	const leaky = harness(finishedEntries(`Rotated the key. New value: ${FAKE_SK} and Bearer abcdef0123456789abcdef0123456789.`));
	await idleAndSettle(leaky);
	assert.ok(!JSON.stringify(leaky.judged[0].state).includes("sk-live1234567890"));
	assert.ok(!JSON.stringify(leaky.generated[0]?.prompt ?? "").includes("sk-live1234567890"));
	h.cleanup();
	leaky.cleanup();
	console.log("PASS analysis: counts, retries, models, native stop-check carried, secrets redacted");
}

await finishedRunsOnce();
await midTaskSkipped();
await questionSkippedWithoutModel();
await jevDownQuiet();
await twoIdlesOneRetro();
await preGates();
await killSwitch();
await workRepoRules();
await userContinuesMidRetro();
await sessionSwitchedMidRetro();
await followUpStopWhileCheckInFlight();
await workRepoInChildDirectory();
await credentialsStripped();
await generationFailureGivesUp();
await lateIdle();
await analysis();
console.log("\nall auto-retro checks passed");
