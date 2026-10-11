import { repoFromToken } from "../auth.ts";
import { HttpError, field, json, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import type { Verdict } from "../store/port.ts";

export function verdictOf(value: unknown): Verdict {
    if (value !== "accepted" && value !== "rejected") {
        throw new HttpError(400, "verdict must be accepted or rejected");
    }
    return value;
}

/**
 * POST /feedback from a repository (token auth), for example a bot reacting to a PR comment.
 * Rejected findings flow back into the suppression table sent by the next /init.
 */
export async function handleFeedback(request: Request, deps: Deps): Promise<Response> {
    const repo = await repoFromToken(request, deps);
    const body = await readJson(request);
    const verdict = verdictOf(body.verdict);
    const reason = verdict === "rejected" ? field(body, "reason") : String(body.reason ?? "");
    const updated = await deps.store.feedback({
        repoId: repo.id,
        fingerprint: field(body, "fingerprint"),
        verdict,
        reason,
        source: "token:" + String(body.source ?? "runner"),
    });
    return json({ updated });
}
