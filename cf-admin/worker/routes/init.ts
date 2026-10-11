import { repoFromToken } from "../auth.ts";
import { HttpError, json, month } from "../http.ts";
import type { Deps } from "../http.ts";
import type { RepoRow } from "../store/port.ts";

const MAX_CANDIDATES = 12;

/** Why a repo gets L0-only config, or null when the model step may run. */
function l0Reason(repo: RepoRow, now: Date, hasProvider: boolean, hasKey: boolean): string | null {
    if (!repo.enabled) {
        return "repository disabled";
    }
    if (repo.mode === "l0") {
        return "mode is l0";
    }
    const spent = repo.budgetMonth === month(now) ? repo.spentUsd : 0;
    if (repo.budgetUsd > 0 && spent >= repo.budgetUsd) {
        return `monthly budget used (${spent.toFixed(2)} of ${repo.budgetUsd.toFixed(2)} USD)`;
    }
    if (!hasProvider || !repo.finderModel || !repo.verifierModel) {
        return "provider or models not configured";
    }
    return hasKey ? null : "provider key secret missing";
}

/**
 * GET /init: validate HX_CTX_TOKEN, return api_url + api_key + model tiers, last_sha and the
 * suppression table. Disabled or over-budget repos get L0 config only, never a key.
 */
export async function handleInit(request: Request, deps: Deps): Promise<Response> {
    const repo = await repoFromToken(request, deps);
    const asked = new URL(request.url).searchParams.get("repo");
    if (asked && asked.toLowerCase() !== repo.name.toLowerCase()) {
        throw new HttpError(403, "token belongs to a different repository");
    }
    const provider = await deps.store.provider(repo.provider);
    const apiKey = provider ? deps.secret(provider.keySecret) : undefined;
    const reason = l0Reason(repo, deps.now(), Boolean(provider), Boolean(apiKey));
    const base = {
        repo: repo.name,
        enabled: repo.enabled,
        l0Only: reason !== null,
        reason: reason ?? undefined,
        api: provider?.api ?? "openai-completions",
        models: { finder: repo.finderModel, verifier: repo.verifierModel },
        limits: {
            contextWindow: provider?.contextWindow ?? 0,
            maxTokens: provider?.maxTokens ?? 0,
            maxCandidates: MAX_CANDIDATES,
        },
        pricing: {
            input: provider?.priceInput ?? 0,
            output: provider?.priceOutput ?? 0,
            cacheRead: provider?.priceCacheRead ?? 0,
            cacheWrite: provider?.priceCacheWrite ?? 0,
        },
        lastSha: repo.lastSha ?? undefined,
        suppressions: await deps.store.suppressions(repo.id),
    };
    if (reason !== null || !provider || !apiKey) {
        return json(base);
    }
    return json({ ...base, apiUrl: provider.apiUrl, apiKey });
}
