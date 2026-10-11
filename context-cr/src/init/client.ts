import type { RefIndex } from "../scope/index.ts";

export type ModelApi = "openai-completions" | "anthropic-messages";
export type Suppression = { fingerprint: string; reason: string };

/** Shape returned by the CF Worker GET /init. The api key never reaches a file, only the env. */
export type InitConfig = {
    repo: string;
    enabled: boolean;
    /** True when the repo is disabled or over budget: only L0 runs, no model credentials sent. */
    l0Only: boolean;
    reason?: string;
    apiUrl?: string;
    api: ModelApi;
    models: { finder: string; verifier: string };
    limits: { contextWindow: number; maxTokens: number; maxCandidates: number };
    /** USD per million tokens, so pi reports real cost and the monthly budget can trip. */
    pricing: { input: number; output: number; cacheRead: number; cacheWrite: number };
    lastSha?: string;
    suppressions: Suppression[];
    refIndex?: RefIndex;
};

export type InitResponse = InitConfig & { apiKey?: string };

function text(value: unknown, field: string): string {
    if (typeof value !== "string" || !value) {
        throw new Error(`init response field ${field} must be a nonempty string`);
    }
    return value;
}

function price(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function parseInit(raw: unknown): InitResponse {
    const data = raw as Record<string, unknown>;
    const models = (data.models ?? {}) as Record<string, unknown>;
    const limits = (data.limits ?? {}) as Record<string, unknown>;
    const pricing = (data.pricing ?? {}) as Record<string, unknown>;
    const l0Only = data.l0Only === true;
    const result: InitResponse = {
        repo: text(data.repo, "repo"),
        enabled: data.enabled !== false,
        l0Only,
        reason: typeof data.reason === "string" ? data.reason : undefined,
        api: data.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions",
        models: {
            finder: l0Only ? String(models.finder ?? "") : text(models.finder, "models.finder"),
            verifier: l0Only ? String(models.verifier ?? "") : text(models.verifier, "models.verifier"),
        },
        limits: {
            contextWindow: Number(limits.contextWindow ?? 128000),
            maxTokens: Number(limits.maxTokens ?? 8192),
            maxCandidates: Number(limits.maxCandidates ?? 12),
        },
        pricing: {
            input: price(pricing.input),
            output: price(pricing.output),
            cacheRead: price(pricing.cacheRead),
            cacheWrite: price(pricing.cacheWrite),
        },
        lastSha: typeof data.lastSha === "string" ? data.lastSha : undefined,
        suppressions: Array.isArray(data.suppressions) ? (data.suppressions as InitResponse["suppressions"]) : [],
        refIndex: (data.refIndex as RefIndex | undefined) ?? undefined,
    };
    if (!l0Only) {
        result.apiUrl = text(data.apiUrl, "apiUrl");
        result.apiKey = text(data.apiKey, "apiKey");
    }
    return result;
}

export async function fetchInit(endpoint: string, token: string, repo: string): Promise<InitResponse> {
    const url = new URL("/init", endpoint);
    url.searchParams.set("repo", repo);
    const response = await fetch(url, { headers: { authorization: "Bearer " + token } });
    if (!response.ok) {
        throw new Error(`GET /init failed with ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return parseInit(await response.json());
}

/** Split the secret out so it is masked and exported only through the environment. */
export function splitSecret(response: InitResponse): { config: InitConfig; apiKey?: string } {
    const { apiKey, ...config } = response;
    return { config, apiKey };
}
