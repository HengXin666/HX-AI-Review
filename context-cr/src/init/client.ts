export type ModelApi = "openai-completions" | "anthropic-messages";
export type Suppression = { fingerprint: string; reason: string };

/** Shape returned by the CF Worker GET /init. The api key never reaches a file, only the env. */
export type InitConfig = {
    repo: string;
    enabled: boolean;
    /** True when the repo is disabled or over budget: only L0 runs, no model credentials sent. */
    l0Only: boolean;
    reason?: string;
    /** Machine-readable reason for l0Only: disabled and mode are intentional; budget and config leave the range unreviewed. */
    l0Cause?: "disabled" | "mode" | "budget" | "config";
    apiUrl?: string;
    api: ModelApi;
    models: { finder: string; verifier: string };
    /** maxRunUsd: remaining monthly budget, null when the repo has no cap. */
    limits: { contextWindow: number; maxTokens: number; maxCandidates: number; maxRunUsd: number | null };
    /** USD per million tokens, so pi reports real cost and the monthly budget can trip. */
    pricing: { input: number; output: number; cacheRead: number; cacheWrite: number };
    lastSha?: string;
    suppressions: Suppression[];
    /** Opaque budget claim from /init; POST /runs echoes it so only the holder releases the reservation. */
    budgetClaim?: string;
};

export type InitResponse = InitConfig & { apiKey?: string };

function text(value: unknown, field: string): string {
    if (typeof value !== "string" || !value) {
        throw new Error(`init response field ${field} must be a nonempty string`);
    }
    return value;
}

// A malformed /init is a hard error: silently defaulting a price, limit or protocol would mis-bill or misroute.
function price(value: unknown, field: string): number {
    if (value === undefined) {
        return 0;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`init response field ${field} must be a non-negative number`);
    }
    return value;
}

function count(value: unknown, field: string, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
        throw new Error(`init response field ${field} must be a positive integer`);
    }
    return value as number;
}

const CAUSES = ["disabled", "mode", "budget", "config"] as const;

/**
 * Why the server went L0-only. A missing or unknown cause cannot be distinguished from an intentional
 * choice, so it fails closed as "config": the range counts as unreviewed and last_sha stays put.
 */
function l0CauseOf(value: unknown, l0Only: boolean): InitConfig["l0Cause"] {
    return CAUSES.find((cause) => cause === value) ?? (l0Only ? "config" : undefined);
}

/** Only an explicit null means "no cap"; a missing field would silently disable the run budget. */
function runBudget(value: unknown, l0Only: boolean): number | null {
    if (value === null) {
        return null;
    }
    if (value === undefined) {
        if (l0Only) {
            return null;
        }
        throw new Error("init response field limits.maxRunUsd is required; null means no cap");
    }
    return price(value, "limits.maxRunUsd");
}

function apiOf(value: unknown, l0Only: boolean): ModelApi {
    if (value === "openai-completions" || value === "anthropic-messages") {
        return value;
    }
    if (l0Only && value === undefined) {
        return "openai-completions";
    }
    throw new Error(`init response field api is not a supported protocol: ${String(value)}`);
}

/** Model prices must be present when a model will be called, or the run budget could never trip. */
function modelPrice(value: unknown, field: string, l0Only: boolean): number {
    if (value === undefined && !l0Only) {
        throw new Error(`init response field ${field} is required`);
    }
    return price(value, field);
}

function suppressionsOf(value: unknown): Suppression[] {
    if (value === undefined) {
        return [];
    }
    const valid = (item: unknown): item is Suppression =>
        typeof (item as Suppression | null)?.fingerprint === "string" &&
        typeof (item as Suppression).reason === "string";
    if (!Array.isArray(value) || !value.every(valid)) {
        throw new Error("init response field suppressions must be a list of { fingerprint, reason }");
    }
    return value;
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
        l0Cause: l0CauseOf(data.l0Cause, l0Only),
        api: apiOf(data.api, l0Only),
        models: {
            finder: l0Only ? String(models.finder ?? "") : text(models.finder, "models.finder"),
            verifier: l0Only ? String(models.verifier ?? "") : text(models.verifier, "models.verifier"),
        },
        limits: {
            // An L0-only config carries zeros here; they are never used.
            contextWindow: l0Only ? 0 : count(limits.contextWindow, "limits.contextWindow", 128000),
            maxTokens: l0Only ? 0 : count(limits.maxTokens, "limits.maxTokens", 8192),
            maxCandidates: l0Only ? 0 : count(limits.maxCandidates, "limits.maxCandidates", 12),
            maxRunUsd: runBudget(limits.maxRunUsd, l0Only),
        },
        pricing: {
            input: modelPrice(pricing.input, "pricing.input", l0Only),
            output: modelPrice(pricing.output, "pricing.output", l0Only),
            cacheRead: price(pricing.cacheRead, "pricing.cacheRead"),
            cacheWrite: price(pricing.cacheWrite, "pricing.cacheWrite"),
        },
        lastSha: typeof data.lastSha === "string" ? data.lastSha : undefined,
        suppressions: suppressionsOf(data.suppressions),
        budgetClaim: typeof data.budgetClaim === "string" ? data.budgetClaim : undefined,
    };
    // A capped run is handed a reservation that must be marked as spending before its first session;
    // without the claim the marker cannot be sent, and a takeover would settle the run as free.
    if (!l0Only && result.limits.maxRunUsd !== null && !result.budgetClaim) {
        throw new Error("init response field budgetClaim is required for a capped run; null maxRunUsd means no cap");
    }
    if (!l0Only) {
        result.apiUrl = text(data.apiUrl, "apiUrl");
        result.apiKey = text(data.apiKey, "apiKey");
    }
    return result;
}

export async function fetchInit(endpoint: string, token: string, repo: string, group?: string): Promise<InitResponse> {
    const url = new URL("/init", endpoint);
    url.searchParams.set("repo", repo);
    if (group) {
        // Identifies the runs GitHub may have cancelled to start this one; see the Worker's reservation.
        url.searchParams.set("group", group);
    }
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
