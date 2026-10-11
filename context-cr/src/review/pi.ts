// Real AgentRunner backed by the pi coding agent SDK. pi talks to api_url directly; CF is not on this path.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createAgentSession,
    createExtensionRuntime,
    defineTool,
    ModelRuntime,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ResourceLoader, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PI_PROVIDER, SESSION_MAX_TURNS } from "../constants.ts";
import type { InitConfig } from "../init/client.ts";
import { SessionError } from "./agent.ts";
import type { AgentRequest, AgentResult, AgentRunner, ToolSpec } from "./agent.ts";
import { repoTools } from "./tools.ts";

/** No discovery: the reviewed repo's AGENTS, skills and extensions are data under review, not instructions. */
function isolatedLoader(system: string): ResourceLoader {
    return {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => system,
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => {},
        reload: async () => {},
    } as ResourceLoader;
}

function toPiTool(spec: ToolSpec): ToolDefinition {
    return defineTool({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters,
        execute: async (_id, params, signal) => ({
            content: [{ type: "text", text: await spec.execute(params as Record<string, unknown>, signal) }],
            details: {},
        }),
    }) as unknown as ToolDefinition;
}

/** Why the last assistant message ended abnormally, or "" when it finished normally. */
export function failureOf(messages: readonly unknown[]): string {
    const last = [...messages].reverse().find((item) => (item as { role?: string }).role === "assistant") as
        { stopReason?: string; errorMessage?: string } | undefined;
    if (!last) {
        return "produced no assistant message";
    }
    if (last.stopReason === "error" || last.stopReason === "aborted") {
        return `ended with ${last.stopReason}${last.errorMessage ? ": " + last.errorMessage : ""}`;
    }
    if (last.stopReason === "length") {
        return "hit the output token limit";
    }
    return "";
}

export async function createPiRunner(root: string, config: InitConfig, apiKey: string): Promise<AgentRunner> {
    if (!config.apiUrl) {
        throw new Error("init returned no api_url; the repository is in L0-only mode");
    }
    const home = mkdtempSync(join(tmpdir(), "hx-ctx-pi-"));
    const runtime = await ModelRuntime.create({
        authPath: join(home, "auth.json"),
        modelsPath: join(home, "models.json"),
    });
    const ids = [...new Set([config.models.finder, config.models.verifier])];
    runtime.registerProvider(PI_PROVIDER, {
        baseUrl: config.apiUrl,
        api: config.api,
        models: ids.map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { ...config.pricing },
            contextWindow: config.limits.contextWindow,
            maxTokens: config.limits.maxTokens,
        })),
    });
    await runtime.setRuntimeApiKey(PI_PROVIDER, apiKey);
    process.once("exit", () => rmSync(home, { recursive: true, force: true }));

    return async (request: AgentRequest): Promise<AgentResult> => {
        const model = runtime.getModel(PI_PROVIDER, request.model);
        if (!model) {
            throw new Error(`model ${request.model} is not registered for ${PI_PROVIDER}`);
        }
        // pi's built-in read/grep/find/ls resolve any path; the review uses git-backed tools limited to tracked files.
        const specs = [...repoTools(root), ...request.tools];
        const customTools = specs.map(toPiTool);
        const { session } = await createAgentSession({
            cwd: root,
            agentDir: home,
            model,
            thinkingLevel: "off",
            modelRuntime: runtime,
            resourceLoader: isolatedLoader(request.system),
            tools: specs.map((tool) => tool.name),
            customTools,
            sessionManager: SessionManager.inMemory(root),
            settingsManager: SettingsManager.inMemory({
                compaction: { enabled: false },
                retry: { enabled: true, maxRetries: 2 },
            }),
        });
        // A looping or hanging session is aborted; the caller treats the throw as an incomplete review.
        let turns = 0;
        let stopped = "";
        const stop = (why: string) => {
            stopped ||= why;
            void session.abort();
        };
        const unsubscribe = session.subscribe((event) => {
            // Abort only when a further turn is needed. A session that ends on its 40th turn_end with a
            // normal answer is complete; aborting there would discard the candidates it just reported.
            if (event.type === "turn_end") {
                turns++;
                const assistant = event.message as { stopReason?: string } | undefined;
                const finished = assistant?.stopReason === "stop" || assistant?.stopReason === "length";
                if (turns >= SESSION_MAX_TURNS && !finished) {
                    stop(`exceeded ${SESSION_MAX_TURNS} turns`);
                }
            }
        });
        const timer = setTimeout(
            () => stop(`timed out after ${Math.round(request.timeoutMs / 1000)}s`),
            request.timeoutMs,
        );
        try {
            await session.prompt(request.prompt);
            const stats = session.getSessionStats();
            const result: AgentResult = {
                usage: {
                    input: stats.tokens.input,
                    output: stats.tokens.output,
                    cacheRead: stats.tokens.cacheRead,
                    cacheWrite: stats.tokens.cacheWrite,
                    cost: stats.cost,
                },
                transcript: [...session.messages],
            };
            // pi does not throw on provider errors: it ends the run with an error stop reason instead.
            const failure = stopped || failureOf(session.messages);
            if (failure) {
                throw new SessionError(`${request.role} session ${failure}`, result);
            }
            return result;
        } finally {
            clearTimeout(timer);
            unsubscribe();
            session.dispose();
        }
    };
}
