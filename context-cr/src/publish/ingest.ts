import type { Finding, Patch, Usage } from "../contract/finding.ts";

export type RunStatus = "passed" | "warned" | "failed" | "skipped" | "incomplete";

/** Body of POST /runs. Large text goes to R2, rows go to D1; the Worker also advances last_sha. */
export type RunPayload = {
    repo: string;
    sha: string;
    baseSha: string;
    event: string;
    prNumber?: number;
    status: RunStatus;
    /** False when the AI stage was expected but did not finish; the Worker then keeps last_sha. */
    complete: boolean;
    l0Only: boolean;
    durationMs: number;
    usage: Usage;
    counts: { error: number; warning: number; blocking: number };
    findings: Finding[];
    patches: Patch[];
    patchBranch?: string;
    /** The /init budget claim, so the Worker releases this run's reservation and not another's. */
    budgetClaim?: string;
    reportMarkdown: string;
    reportJson: string;
    sessionsJsonl: string;
};

export type IngestResult = { runId: string; overviewUrl?: string };

/** A run whose AI stage did not finish is never "passed": it reports incomplete unless L0 already failed it. */
export function statusOf(counts: RunPayload["counts"], skipped: boolean, complete = true): RunStatus {
    if (counts.blocking > 0) {
        return "failed";
    }
    if (!complete) {
        return "incomplete";
    }
    if (counts.error + counts.warning > 0) {
        return "warned";
    }
    return skipped ? "skipped" : "passed";
}

export function sessionsToJsonl(transcripts: { role: string; index: number; messages: unknown[] }[]): string {
    const lines: string[] = [];
    for (const item of transcripts) {
        for (const message of item.messages) {
            lines.push(JSON.stringify({ role: item.role, session: item.index, message }));
        }
    }
    return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * Tells the Worker that this run is about to open its first model session. The budget claim is only
 * settled if it was marked as started, so a run cancelled during install or scope is charged nothing.
 *
 * Throws when the marker cannot be recorded: starting the session anyway would spend budget the Worker
 * still believes is unspent, and if this run were then cancelled the takeover would hand the same
 * remainder out again. The caller fails the review closed, which only costs a re-review of this range.
 */
export async function postSpend(endpoint: string, token: string, budgetClaim: string): Promise<void> {
    const response = await fetch(new URL("/spend", endpoint), {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ budgetClaim }),
    });
    if (!response.ok) {
        throw new Error(`POST /spend failed with ${response.status}`);
    }
}

export async function postRun(endpoint: string, token: string, payload: RunPayload): Promise<IngestResult> {
    const response = await fetch(new URL("/runs", endpoint), {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        throw new Error(`POST /runs failed with ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return (await response.json()) as IngestResult;
}
