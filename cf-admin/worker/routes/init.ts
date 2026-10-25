import { repoFromToken } from "../auth.ts";
import { HttpError, json, month } from "../http.ts";
import type { Deps } from "../http.ts";
import type { Kind, ProviderRow, RepoKind, RepoRow } from "../store/port.ts";

const MAX_CANDIDATES = 12;
/** A claim older than this is treated as abandoned (job timeout is 30 minutes), so a crashed run cannot block. */
const RESERVE_TTL_MS = 60 * 60 * 1000;
const BUSY = "another run is using this month's budget";

function spentThisMonth(repo: RepoRow, now: Date): number {
    return repo.budgetMonth === month(now) ? repo.spentUsd : 0;
}

type L0 = { cause: "disabled" | "mode" | "budget" | "config"; reason: string };

const positiveInt = (value: number) => Number.isSafeInteger(value) && value >= 1;

const KINDS: readonly Kind[] = ["context", "code"];

/**
 * The kind this run performs. Absent means context, which is what every caller did before kinds existed.
 * A repo registered for one kind rejects the other, so a misconfigured workflow fails loudly instead of
 * quietly running the wrong review and charging its budget.
 */
function kindParam(raw: string | null, served: RepoKind): Kind {
    if (raw === null || raw === "") {
        return served === "code" ? "code" : "context";
    }
    const kind = KINDS.find((item) => item === raw);
    if (!kind) {
        throw new HttpError(400, `kind must be one of ${KINDS.join(", ")}`);
    }
    if (served !== "both" && served !== kind) {
        throw new HttpError(400, `repository is registered for ${served} reviews, not ${kind}`);
    }
    return kind;
}

async function promptPayload(deps: Deps) {
    const active = await deps.store.activePrompts();
    const pick = (role: "finder" | "verifier") => {
        const row = active.find((item) => item.role === role);
        return row ? { version: row.version, body: row.body } : null;
    };
    return { finder: pick("finder"), verifier: pick("verifier") };
}

/**
 * This request's budget claim, echoed back by POST /runs so only the holder can release it. The allowance
 * is the remaining budget, recorded on the claim so a later takeover settles it instead of handing the
 * same remainder out again to a run whose predecessor was cancelled before it could report.
 */
async function claimBudget(
    deps: Deps,
    repoId: number,
    now: Date,
    group: string,
    allowanceUsd: number,
): Promise<{ claim: string; allowanceUsd: number } | null> {
    const claim = deps.id();
    const expiresAt = new Date(now.getTime() + RESERVE_TTL_MS).toISOString();
    const outcome = await deps.store.reserveBudget(
        repoId,
        claim,
        group,
        allowanceUsd,
        month(now),
        now.toISOString(),
        expiresAt,
    );
    return outcome.claimed ? { claim, allowanceUsd: outcome.remainingUsd } : null;
}

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
 *
 * A budgeted repo's remainder is claimed atomically here, before the key is handed out: runs finish
 * minutes later and only then report their cost, so without a claim two concurrent PRs would each be
 * given the same unspent remainder and could overspend the month together.
 */
export async function handleInit(request: Request, deps: Deps): Promise<Response> {
    const repo = await repoFromToken(request, deps);
    const params = new URL(request.url).searchParams;
    const asked = params.get("repo");
    if (asked && asked.toLowerCase() !== repo.name.toLowerCase()) {
        throw new HttpError(403, "token belongs to a different repository");
    }
    // A run is exactly one kind. Callers that predate kinds send nothing and get context, which is what
    // the tool did before; an explicit kind the repo does not serve is a 400 rather than a silent switch.
    const kind = kindParam(params.get("kind"), repo.kind);
    // mode=l0 means "deterministic checks only, no model". A code review has no deterministic stage, so the
    // pair is contradictory: the run would neither check anything nor review anything and still report a
    // status. Refuse it here, where the operator can see which of the two settings to change.
    if (kind === "code" && repo.mode === "l0") {
        throw new HttpError(
            400,
            "mode is l0 but the requested kind is code: a code review has no L0 stage, so set mode to full " +
                "or register the repository for context reviews",
        );
    }
    const provider = await deps.store.provider(repo.provider);
    const apiKey = provider ? deps.secret(provider.keySecret) : undefined;
    const now = deps.now();
    const reason = l0Reason(repo, now, provider, Boolean(apiKey));
    // Only a capped repo that would otherwise get a model run needs a claim; the concurrency group lets
    // a run take over the claim of the run GitHub just cancelled to start it.
    const group = new URL(request.url).searchParams.get("group") ?? "";
    const remaining = Math.max(0, repo.budgetUsd - spentThisMonth(repo, now));
    const held = !reason && repo.budgetUsd > 0 ? await claimBudget(deps, repo.id, now, group, remaining) : null;
    const l0 = reason ?? (repo.budgetUsd > 0 && !held ? { cause: "budget" as const, reason: BUSY } : null);
    const base = {
        repo: repo.name,
        enabled: repo.enabled,
        kind,
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
            // The claim's settled allowance is the authoritative figure: taking over a cancelled run's
            // claim charges that allowance first, and the raw row is only re-read for uncapped repos.
            maxRunUsd: repo.budgetUsd > 0 ? (held ? held.allowanceUsd : remaining) : null,
        },
        pricing: {
            input: provider?.priceInput ?? 0,
            output: provider?.priceOutput ?? 0,
            cacheRead: provider?.priceCacheRead ?? 0,
            cacheWrite: provider?.priceCacheWrite ?? 0,
        },
        // last_sha is the "context already reviewed up to here" cursor; a code review has no such cursor,
        // so it must not inherit one and must not advance it either (POST /runs decides that).
        lastSha: kind === "context" ? (repo.lastSha ?? undefined) : undefined,
        suppressions: await deps.store.suppressions(repo.id),
        prompts: await promptPayload(deps),
        // The runner sends this back on POST /runs; it is what lets that call release this claim.
        budgetClaim: held?.claim,
    };
    if (l0 !== null || !provider || !apiKey) {
        return json(base);
    }
    return json({ ...base, apiUrl: provider.apiUrl, apiKey });
}
