import { repoFromToken } from "../auth.ts";
import { HttpError, json, month } from "../http.ts";
import type { Deps } from "../http.ts";
import type { ProviderRow, RepoRow } from "../store/port.ts";

const MAX_CANDIDATES = 12;

function spentThisMonth(repo: RepoRow, now: Date): number {
    return repo.budgetMonth === month(now) ? repo.spentUsd : 0;
}

type L0 = { cause: "disabled" | "mode" | "budget" | "config"; reason: string };

const positiveInt = (value: number) => Number.isSafeInteger(value) && value >= 1;

/**
 * Why a repo gets L0-only config, or null when the model step may run. disabled and mode are choices;
 * budget and config mean the range was not reviewed, so the runner reports incomplete and last_sha stays.
 */
function l0Reason(repo: RepoRow, now: Date, provider: ProviderRow | null, hasKey: boolean): L0 | null {
    if (!repo.enabled) {
        return { cause: "disabled", reason: "repository disabled" };
    }
    if (repo.mode === "l0") {
        return { cause: "mode", reason: "mode is l0" };
    }
    const spent = spentThisMonth(repo, now);
    if (repo.budgetUsd > 0 && spent >= repo.budgetUsd) {
        const used = `${spent.toFixed(2)} of ${repo.budgetUsd.toFixed(2)} USD`;
        return { cause: "budget", reason: `monthly budget used (${used})` };
    }
    if (!provider || !repo.finderModel || !repo.verifierModel) {
        return { cause: "config", reason: "provider or models not configured" };
    }
    // Rows written before limits were validated may hold 0 or fractions; never send them to a model.
    if (!positiveInt(provider.contextWindow) || !positiveInt(provider.maxTokens)) {
        return { cause: "config", reason: "provider contextWindow and maxTokens must be positive integers" };
    }
    return hasKey ? null : { cause: "config", reason: "provider key secret missing" };
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
    const l0 = l0Reason(repo, deps.now(), provider, Boolean(apiKey));
    const base = {
        repo: repo.name,
        enabled: repo.enabled,
        l0Only: l0 !== null,
        reason: l0?.reason,
        l0Cause: l0?.cause,
        api: provider?.api ?? "openai-completions",
        models: { finder: repo.finderModel, verifier: repo.verifierModel },
        limits: {
            contextWindow: provider?.contextWindow ?? 0,
            maxTokens: provider?.maxTokens ?? 0,
            maxCandidates: MAX_CANDIDATES,
            // Remaining monthly budget; the runner stops opening model sessions once a run reaches it.
            maxRunUsd: repo.budgetUsd > 0 ? Math.max(0, repo.budgetUsd - spentThisMonth(repo, deps.now())) : null,
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
    if (l0 !== null || !provider || !apiKey) {
        return json(base);
    }
    return json({ ...base, apiUrl: provider.apiUrl, apiKey });
}
