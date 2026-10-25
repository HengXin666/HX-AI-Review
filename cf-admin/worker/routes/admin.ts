import { newToken, requireAdmin, sha256Hex } from "../auth.ts";
import { HttpError, field, json, month, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import type { RepoPatch } from "../store/port.ts";
import { verdictOf } from "./feedback.ts";
import { handlePrompts } from "./prompts.ts";
import { handleRules } from "./rules.ts";
import { handleSession } from "./session.ts";
import { PROVIDER_NAME, handleProviderPut } from "./providers.ts";

const LIST_LIMIT = 50;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const CONFLICT = "repository already registered (names are case-insensitive)";

/** Omitted fields stay untouched; a present field with a wrong type or value is a 400, never ignored. */
function repoPatch(body: Record<string, unknown>): RepoPatch {
    const patch: RepoPatch = {};
    const bad = (key: string, rule: string) => new HttpError(400, `${key} must be ${rule}`);
    if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
            throw bad("enabled", "a boolean");
        }
        patch.enabled = body.enabled;
    }
    if (body.mode !== undefined) {
        if (body.mode !== "full" && body.mode !== "l0") {
            throw bad("mode", '"full" or "l0"');
        }
        patch.mode = body.mode;
    }
    if (body.kind !== undefined) {
        if (body.kind !== "context" && body.kind !== "code" && body.kind !== "both") {
            throw bad("kind", '"context", "code" or "both"');
        }
        patch.kind = body.kind;
    }
    if (body.provider !== undefined) {
        if (typeof body.provider !== "string" || !PROVIDER_NAME.test(body.provider)) {
            throw bad("provider", "a provider name (letters, digits, '.', '_', '-')");
        }
        patch.provider = body.provider;
    }
    for (const key of ["finderModel", "verifierModel"] as const) {
        if (body[key] !== undefined) {
            if (typeof body[key] !== "string") {
                throw bad(key, "a string");
            }
            patch[key] = body[key];
        }
    }
    if (body.budgetUsd !== undefined) {
        const budget = body.budgetUsd;
        if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) {
            throw bad("budgetUsd", "a non-negative number (0 means no cap)");
        }
        patch.budgetUsd = budget;
    }
    return patch;
}

/** The UNIQUE COLLATE NOCASE constraint is the source of truth, so concurrent creates also get a 409. */
async function createRepoOrConflict(deps: Deps, name: string, tokenHash: string, patch: RepoPatch) {
    if (await deps.store.repoByName(name)) {
        throw new HttpError(409, CONFLICT);
    }
    try {
        return await deps.store.createRepo(name, tokenHash, patch);
    } catch (error) {
        if (/UNIQUE/i.test(String(error))) {
            throw new HttpError(409, CONFLICT);
        }
        throw error;
    }
}

/** GET /api/overview: every repo on one screen with recent runs and pending findings. */
async function overview(deps: Deps): Promise<Response> {
    const current = month(deps.now());
    const repos = (await deps.store.listRepos()).map((repo) => ({
        ...repo,
        spentUsd: repo.budgetMonth === current ? repo.spentUsd : 0,
    }));
    const [runs, findings, resolved, providers, prompts, notes] = await Promise.all([
        deps.store.recentRuns(LIST_LIMIT),
        deps.store.openFindings(LIST_LIMIT),
        deps.store.findingsByStatus("resolved", LIST_LIMIT),
        deps.store.listProviders(),
        deps.store.listPromptVersions(),
        deps.store.listPromptNotes(LIST_LIMIT),
    ]);
    // Never the key itself: only whether the named Worker secret exists.
    const providerView = providers.map((item) => ({ ...item, keyPresent: Boolean(deps.secret(item.keySecret)) }));
    return json({
        month: current,
        deployment: { ...deps.deployment, passwordLogin: Boolean(deps.credentials?.user && deps.credentials.password) },
        repos,
        runs,
        findings,
        resolved,
        prompts,
        notes,
        providers: providerView,
    });
}

/** Admin API behind Cloudflare Access. Path segments after /api/. */
export async function handleAdmin(request: Request, deps: Deps, parts: string[]): Promise<Response> {
    const method = request.method;
    const [resource, ...rest] = parts;
    if (resource === "session") {
        return handleSession(request, deps);
    }
    const who = await requireAdmin(request, deps);
    if (method === "GET" && resource === "overview") {
        return overview(deps);
    }
    if (method === "GET" && resource === "status") {
        return json({ deployment: deps.deployment, admin: who });
    }
    if (resource === "repos") {
        if (method === "POST" && rest.length === 0) {
            const body = await readJson(request);
            const name = field(body, "name");
            if (!REPO_NAME.test(name)) {
                throw new HttpError(400, "name must be owner/repo");
            }
            const token = newToken();
            const repo = await createRepoOrConflict(deps, name, await sha256Hex(token), repoPatch(body));
            // The token is shown once; store it as the caller repo secret HX_CTX_TOKEN.
            return json({ repo, token }, 201);
        }
        const name = decodeURIComponent(rest.slice(0, 2).join("/"));
        if (method === "PATCH" && rest.length === 2) {
            const repo = await deps.store.updateRepo(name, repoPatch(await readJson(request)));
            return repo ? json({ repo }) : json({ error: "not found" }, 404);
        }
        if (method === "POST" && rest[2] === "rotate-token") {
            const token = newToken();
            const ok = await deps.store.setTokenHash(name, await sha256Hex(token));
            return ok ? json({ token }) : json({ error: "not found" }, 404);
        }
    }
    if (resource === "providers" && method === "PUT" && rest.length === 1) {
        return handleProviderPut(request, deps, rest[0]);
    }
    if (resource === "prompts") {
        return handlePrompts(request, deps, rest);
    }
    if (method === "GET" && resource === "rules") {
        return handleRules(request, deps);
    }
    if (resource === "findings" && rest.length === 2) {
        const finding = await deps.store.finding(rest[0]);
        if (!finding) {
            return json({ error: "not found" }, 404);
        }
        if (method === "GET" && rest[1] === "patch") {
            const patch = finding.patchKey ? await deps.blobs.get(finding.patchKey) : null;
            return patch === null
                ? json({ error: "no patch" }, 404)
                : new Response(patch, { headers: { "content-type": "text/x-diff" } });
        }
        if (method === "POST" && rest[1] === "feedback") {
            const body = await readJson(request);
            const verdict = verdictOf(body.verdict);
            const reason = verdict === "rejected" ? field(body, "reason") : String(body.reason ?? "");
            const updated = await deps.store.feedback({
                repoId: finding.repoId,
                fingerprint: finding.fingerprint,
                verdict,
                reason,
                source: "access:" + who,
            });
            return json({ updated });
        }
    }
    throw new HttpError(404, "no such admin route");
}
