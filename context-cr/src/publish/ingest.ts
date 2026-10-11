import type { Finding, Patch, Usage } from "../contract/finding.ts";

export type RunStatus = "passed" | "warned" | "failed" | "skipped";

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
    reportMarkdown: string;
    reportJson: string;
    sessionsJsonl: string;
};

export type IngestResult = { runId: string; overviewUrl?: string };

export function statusOf(counts: RunPayload["counts"], skipped: boolean): RunStatus {
    if (counts.blocking > 0) {
        return "failed";
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
