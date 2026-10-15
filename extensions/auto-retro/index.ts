// omp entry point. Kept thin: the omp-only imports live here so register.ts stays runnable under plain bun
// for test.ts. Jev goes through jev-tier's native judge (one client, one key); the retro itself runs on the
// smol role chain.
import { readFileSync } from "node:fs";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { createNativeJudge } from "../jev-tier/judge";
import { skillBody } from "./core";
import { defaultPaths, register, type ExtensionAPI, type ExtensionContext, type Generated } from "./register";

interface OmpExtensionAPI extends ExtensionAPI {
	pi: { settings: unknown };
	exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
	registerCommand(name: string, options: { description?: string; handler: (args: string, context: { ui: { notify(message: string, level?: string): void } }) => Promise<void> }): void;
	sendUserMessage(content: string): void;
}

interface OmpModel {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinking?: { efforts?: readonly string[] };
}

interface OmpContext extends ExtensionContext {
	models: { resolve(spec: string): OmpModel | undefined };
	modelRegistry: {
		getApiKey(model: OmpModel, sessionId?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
		resolver(model: OmpModel, sessionId?: string): unknown;
	};
}

// Per candidate, so a hung first model falls through to the next instead of eating the whole budget.
const CANDIDATE_TIMEOUT_MS = 25_000;
const MAX_TOKENS = 2000;

export default function (pi: OmpExtensionAPI): void {
	const judge = createNativeJudge(pi.pi.settings);

	// The smol role, then its configured retry fallback chain (luna -> haiku -> composer in this setup).
	// Same expansion `completion(model: "smol")` uses; the chain is skipped when fallback is switched off.
	const smolCandidates = (context: OmpContext): OmpModel[] => {
		const settings = pi.pi.settings;
		const fallbackOn = lookup("retry.enabled")?.get(settings) !== false && lookup("retry.modelFallback")?.get(settings) !== false;
		const chains = lookup("retry.fallbackChains")?.get(settings);
		const chain = fallbackOn && chains && typeof chains === "object" && "smol" in chains && Array.isArray(chains.smol) ? chains.smol : [];
		const seen = new Set<string>();
		const out: OmpModel[] = [];
		for (const spec of ["@smol", ...chain]) {
			if (typeof spec !== "string") continue;
			const model = context.models.resolve(spec);
			if (!model || seen.has(`${model.provider}/${model.id}`)) continue;
			seen.add(`${model.provider}/${model.id}`);
			out.push(model);
		}
		return out;
	};

	const generate = async (base: ExtensionContext, request: { system: string; prompt: string; signal: AbortSignal }): Promise<Generated> => {
		const context = base as OmpContext;
		const sessionId = context.sessionManager?.getSessionId?.();
		let lastError: unknown;
		for (const model of smolCandidates(context)) {
			if (request.signal.aborted) break;
			const signal = AbortSignal.any([request.signal, AbortSignal.timeout(CANDIDATE_TIMEOUT_MS)]);
			try {
				if (!(await context.modelRegistry.getApiKey(model, sessionId, { signal }))) {
					lastError = new Error(`no credentials for ${model.provider}/${model.id}`);
					continue;
				}
				// Low effort where the model has a controllable effort surface; otherwise nothing to set.
				const efforts = model.reasoning ? (model.thinking?.efforts ?? []) : [];
				const response = await completeSimple(
					model as never,
					{ systemPrompt: [request.system], messages: [{ role: "user", content: [{ type: "text", text: request.prompt }], timestamp: Date.now() }] },
					{
						apiKey: context.modelRegistry.resolver(model, sessionId) as never,
						sessionId,
						signal,
						maxTokens: MAX_TOKENS,
						reasoning: (efforts.includes("low") ? "low" : efforts[0]) as never,
					},
				);
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					lastError = new Error(response.errorMessage ?? `${model.provider}/${model.id} ${response.stopReason}`);
					continue;
				}
				const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
				if (text.trim()) return { text, model: `${model.provider}/${model.id}` };
				lastError = new Error(`${model.provider}/${model.id} returned no text`);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError instanceof Error ? lastError : new Error("no smol model available");
	};

	const readSkill = (): string | undefined => {
		try {
			return readFileSync(defaultPaths.skill, "utf8");
		} catch {
			return undefined;
		}
	};

	register(pi, {
		judge,
		generate,
		exec: (command, args, options) => pi.exec(command, args, options),
		readSkill,
	});

	// omp exposes skills only as `/skill:retro`; this makes the plain `/retro` work too. It hands the skill to the
	// main agent as a normal user message (so it can run git and write the day file itself). The leading `/retro`
	// is what stops the automatic retro from running a second time afterwards.
	pi.registerCommand("retro", {
		description: "Write a short retro for this session and append it to ~/.omp/agent/retros/",
		handler: async (args, context) => {
			const skill = readSkill();
			if (!skill) {
				context.ui.notify(`retro skill not found at ${defaultPaths.skill}`, "error");
				return;
			}
			const focus = args.trim() ? `\n\nFocus: ${args.trim()}` : "";
			pi.sendUserMessage(`/retro (manual)\n\n${skillBody(skill)}${focus}\n\nRun this retro now for the current session.`);
		},
	});
}
