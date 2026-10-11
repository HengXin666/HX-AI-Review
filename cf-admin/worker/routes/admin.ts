import { newToken, requireAdmin, sha256Hex } from "../auth.ts";
import { HttpError, field, json, month, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import type { RepoPatch } from "../store/port.ts";
import { verdictOf } from "./feedback.ts";

const LIST_LIMIT = 50;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

function repoPatch(body: Record<string, unknown>): RepoPatch {
    const patch: RepoPatch = {};
    if (typeof body.enabled === "boolean") {
        patch.enabled = body.enabled;
    }
    if (body.mode === "full" || body.mode === "l0") {
        patch.mode = body.mode;
    }
    if (typeof body.provider === "string" && body.provider) {
        patch.provider = body.provider;
    }
    if (typeof body.finderModel === "string") {
        patch.finderModel = body.finderModel;
    }
    if (typeof body.verifierModel === "string") {
        patch.verifierModel = body.verifierModel;
    }
    if (typeof body.budgetUsd === "number" && body.budgetUsd >= 0) {
        patch.budgetUsd = body.budgetUsd;
    }
    return patch;
}

/** GET /api/overview: every repo on one screen with recent runs and pending findings. */
async function overview(deps: Deps): Promise<Response> {
    const current = month(deps.now());
    const repos = (await deps.store.listRepos()).map((repo) => ({
        ...repo,
        spentUsd: repo.budgetMonth === current ? repo.spentUsd : 0,
    }));
    const [runs, findings] = await Promise.all([
        deps.store.recentRuns(LIST_LIMIT),
        deps.store.openFindings(LIST_LIMIT),
    ]);
    return json({ month: current, repos, runs, findings });
}

/** Admin API behind Cloudflare Access. Path segments after /api/. */
export async function handleAdmin(request: Request, deps: Deps, parts: string[]): Promise<Response> {
    const who = await requireAdmin(request, deps);
    const method = request.method;
    const [resource, ...rest] = parts;
    if (method === "GET" && resource === "overview") {
        return overview(deps);
    }
    if (resource === "repos") {
        if (method === "POST" && rest.length === 0) {
            const body = await readJson(request);
            const name = field(body, "name");
            if (!REPO_NAME.test(name)) {
                throw new HttpError(400, "name must be owner/repo");
            }
            const token = newToken();
            const repo = await deps.store.createRepo(name, await sha256Hex(token), repoPatch(body));
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
        const body = await readJson(request);
        await deps.store.upsertProvider({
            name: rest[0],
            apiUrl: field(body, "apiUrl"),
            api: body.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions",
            keySecret: field(body, "keySecret"),
            contextWindow: Number(body.contextWindow ?? 128000),
            maxTokens: Number(body.maxTokens ?? 8192),
        });
        return json({ ok: true });
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
