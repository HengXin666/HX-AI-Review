// POST /api/webhook/github: GitHub App webhooks. No admin auth: the X-Hub-Signature-256 HMAC is the auth, and
// nothing is written before it verifies. A push to the default branch or a PR update queues one review per kind
// in run_queue and fires workflow_dispatch with head_sha and kind; a failed dispatch is recorded, not a 500.
import { HttpError, json } from "../http.ts";
import { dispatchWorkflow } from "../github/client.ts";
import { KEK_SECRET, verifyWebhookSignature } from "../github/crypto.ts";
import type { GitHubDeps } from "../github/deps.ts";
import type { QueueEvent, QueueKind } from "../github/store.ts";
import { installationToken } from "../github/tokens.ts";

export const SIGNATURE_HEADER = "X-Hub-Signature-256";
export const DEDUP_WINDOW_MS = 10 * 60_000;
const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const ZERO_SHA = /^0+$/;

type Payload = Record<string, unknown>;
type Repository = { full_name?: string; default_branch?: string };
type Account = { login?: string; type?: string };
type RepoRef = { full_name?: string };

type Trigger = {
    repo: string;
    sha: string;
    ref: string;
    event: QueueEvent;
    prNumber: number | null;
    installationId: number | null;
    deliveryId: string | null;
};

function object(value: unknown): Payload {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : {};
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message.slice(0, 500);
    }
    return String(error).slice(0, 500);
}

function ignored(reason: string, extra: Record<string, unknown> = {}): Response {
    return json({ ignored: reason, ...extra }, 202);
}

function installationId(payload: Payload): number | null {
    const id = object(payload.installation).id;
    return typeof id === "number" ? id : null;
}

/** Queue and dispatch one review per kind the repository is registered for. */
async function trigger(gh: GitHubDeps, input: Trigger): Promise<Response> {
    const registered = await gh.store.registeredRepo(input.repo);
    if (!registered) {
        return ignored("repository is not registered in hx-context-review", { repo: input.repo });
    }
    if (!registered.enabled) {
        return ignored("repository is disabled", { repo: input.repo });
    }
    const app = await gh.store.app();
    const workflow = app?.workflowFile ?? "hx-context-review.yml";
    const kinds: QueueKind[] = registered.kind === "both" ? ["context", "code"] : [registered.kind];
    const now = gh.now();
    const nowIso = now.toISOString();
    const since = new Date(now.getTime() - DEDUP_WINDOW_MS).toISOString();
    const installation = input.installationId ?? (await gh.store.installationIdForRepo(input.repo));
    const queued = [];
    for (const kind of kinds) {
        const id = gh.id();
        const inserted = await gh.store.enqueue(
            { id, kind, ...input, repo: registered.name, installationId: installation },
            nowIso,
            since,
        );
        if (!inserted) {
            queued.push({ kind, status: "duplicate" });
            continue;
        }
        try {
            if (installation === null) {
                throw new Error(`the GitHub App has no installation covering ${input.repo}`);
            }
            const token = await installationToken(gh, installation);
            await dispatchWorkflow(gh.fetch, token, registered.name, workflow, input.ref, {
                head_sha: input.sha,
                kind,
            });
            await gh.store.markQueue(id, "dispatched", null, gh.now().toISOString());
            queued.push({ id, kind, status: "dispatched" });
        } catch (error) {
            const reason = errorMessage(error);
            await gh.store.markQueue(id, "failed", reason, gh.now().toISOString());
            queued.push({ id, kind, status: "failed", error: reason });
        }
    }
    return json({ repo: registered.name, sha: input.sha, event: input.event, queued }, 202);
}

/** push: only commits that land on repository.default_branch trigger a review. */
function onPush(gh: GitHubDeps, payload: Payload, deliveryId: string | null): Promise<Response> {
    const repository = object(payload.repository) as Repository;
    const ref = payload.ref;
    const after = payload.after;
    if (!repository.full_name || !repository.default_branch || typeof ref !== "string" || typeof after !== "string") {
        throw new HttpError(400, "push payload needs ref, after, repository.full_name and repository.default_branch");
    }
    if (ref !== `refs/heads/${repository.default_branch}`) {
        return Promise.resolve(
            ignored("push is not to the default branch", { ref, default_branch: repository.default_branch }),
        );
    }
    if (payload.deleted === true || ZERO_SHA.test(after)) {
        return Promise.resolve(ignored("branch deletion"));
    }
    return trigger(gh, {
        repo: repository.full_name,
        sha: after,
        ref: repository.default_branch,
        event: "push",
        prNumber: null,
        installationId: installationId(payload),
        deliveryId,
    });
}

/** pull_request: same-repository PRs only; the workflow runs from the default branch and checks out head_sha. */
function onPullRequest(gh: GitHubDeps, payload: Payload, deliveryId: string | null): Promise<Response> {
    const action = String(payload.action ?? "");
    if (!PR_ACTIONS.has(action)) {
        return Promise.resolve(ignored(`pull_request action ${action} does not trigger a review`));
    }
    const repository = object(payload.repository) as Repository;
    const pr = object(payload.pull_request);
    const head = object(pr.head);
    const headRepo = object(head.repo) as RepoRef;
    if (
        !repository.full_name ||
        !repository.default_branch ||
        typeof head.sha !== "string" ||
        typeof pr.number !== "number"
    ) {
        throw new HttpError(
            400,
            "pull_request payload needs number, head.sha, repository.full_name and default_branch",
        );
    }
    if (pr.draft === true) {
        return Promise.resolve(ignored("draft pull request"));
    }
    // Fork heads are untrusted code; the review workflow refuses them too.
    if (headRepo.full_name && headRepo.full_name.toLowerCase() !== repository.full_name.toLowerCase()) {
        return Promise.resolve(ignored("pull request from a fork"));
    }
    return trigger(gh, {
        repo: repository.full_name,
        sha: head.sha,
        ref: repository.default_branch,
        event: "pull_request",
        prNumber: pr.number,
        installationId: installationId(payload),
        deliveryId,
    });
}

function repoNames(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((item) => object(item).full_name).filter((name): name is string => typeof name === "string")
        : [];
}

async function onInstallation(gh: GitHubDeps, payload: Payload): Promise<Response> {
    const installation = object(payload.installation);
    const id = installation.id;
    if (typeof id !== "number") {
        throw new HttpError(400, "installation payload needs installation.id");
    }
    const action = String(payload.action ?? "");
    const account = object(installation.account) as Account;
    const now = gh.now().toISOString();
    const base = {
        installationId: id,
        account: account.login ?? "",
        accountType: account.type ?? "",
        repositorySelection: String(installation.repository_selection ?? "selected"),
    };
    if (action === "created") {
        await gh.store.upsertInstallation({ ...base, status: "active", repos: repoNames(payload.repositories) }, now);
        await gh.store.markInstalled(now);
    } else if (action === "deleted") {
        await gh.store.upsertInstallation({ ...base, status: "deleted", repos: [] }, now);
    } else if (action === "suspend") {
        await gh.store.upsertInstallation({ ...base, status: "suspended" }, now);
    } else if (action === "unsuspend" || action === "new_permissions_accepted") {
        await gh.store.upsertInstallation({ ...base, status: "active" }, now);
    } else {
        return ignored(`installation action ${action}`);
    }
    return json({ installation: id, action });
}

async function onInstallationRepositories(gh: GitHubDeps, payload: Payload): Promise<Response> {
    const installation = object(payload.installation);
    const id = installation.id;
    if (typeof id !== "number") {
        throw new HttpError(400, "installation_repositories payload needs installation.id");
    }
    const now = gh.now().toISOString();
    if (!(await gh.store.installation(id))) {
        const account = object(installation.account) as Account;
        await gh.store.upsertInstallation(
            {
                installationId: id,
                account: account.login ?? "",
                accountType: account.type ?? "",
                repositorySelection: String(installation.repository_selection ?? "selected"),
                status: "active",
                repos: [],
            },
            now,
        );
    }
    const added = repoNames(payload.repositories_added);
    const removed = repoNames(payload.repositories_removed);
    await gh.store.changeInstallationRepos(id, added, removed, now);
    return json({ installation: id, added, removed });
}

export async function handleGithubWebhook(request: Request, gh: GitHubDeps): Promise<Response> {
    const body = new Uint8Array(await request.arrayBuffer());
    const kek = gh.secret(KEK_SECRET);
    const secret = kek ? await gh.store.webhookSecret(kek) : null;
    if (!secret) {
        throw new HttpError(401, "GitHub App webhook secret is not configured; signature cannot be verified");
    }
    if (!(await verifyWebhookSignature(secret, body, request.headers.get(SIGNATURE_HEADER)))) {
        throw new HttpError(401, `invalid ${SIGNATURE_HEADER}`);
    }
    let payload: Payload;
    try {
        payload = object(JSON.parse(new TextDecoder().decode(body)));
    } catch {
        throw new HttpError(400, "webhook body is not JSON");
    }
    const event = request.headers.get("x-github-event") ?? "";
    const deliveryId = request.headers.get("x-github-delivery");
    switch (event) {
        case "ping":
            return json({ pong: true });
        case "push":
            return onPush(gh, payload, deliveryId);
        case "pull_request":
            return onPullRequest(gh, payload, deliveryId);
        case "installation":
            return onInstallation(gh, payload);
        case "installation_repositories":
            return onInstallationRepositories(gh, payload);
        default:
            return ignored(`event ${event} is not handled`);
    }
}
