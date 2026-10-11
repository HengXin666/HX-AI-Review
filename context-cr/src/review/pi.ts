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
import { PI_PROVIDER, READ_ONLY_TOOLS } from "../constants.ts";
import type { InitConfig } from "../init/client.ts";
import type { AgentRequest, AgentResult, AgentRunner, ToolSpec } from "./agent.ts";

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
        execute: async (_id, params) => ({
            content: [{ type: "text", text: spec.execute(params as Record<string, unknown>) }],
            details: {},
        }),
    }) as unknown as ToolDefinition;
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
            cost: { input: config.pricing.input, output: config.pricing.output, cacheRead: 0, cacheWrite: 0 },
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
        const customTools = request.tools.map(toPiTool);
        const { session } = await createAgentSession({
            cwd: root,
            agentDir: home,
            model,
            thinkingLevel: "off",
            modelRuntime: runtime,
            resourceLoader: isolatedLoader(request.system),
            tools: [...READ_ONLY_TOOLS, ...request.tools.map((tool) => tool.name)],
            customTools,
            sessionManager: SessionManager.inMemory(root),
            settingsManager: SettingsManager.inMemory({
                compaction: { enabled: false },
                retry: { enabled: true, maxRetries: 2 },
            }),
        });
        try {
            await session.prompt(request.prompt);
            const stats = session.getSessionStats();
            return {
                usage: {
                    input: stats.tokens.input,
                    output: stats.tokens.output,
                    cacheRead: stats.tokens.cacheRead,
                    cacheWrite: stats.tokens.cacheWrite,
                    cost: stats.cost,
                },
                transcript: [...session.messages],
            };
        } finally {
            session.dispose();
        }
    };
}
