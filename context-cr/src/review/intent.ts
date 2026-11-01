// Intent card for code CR: what the change claims to do, taken from the PR, linked issues,
// and commit messages. The card is untrusted data. The finder checks the diff against it.
// Design: docs/architecture/agent-review.md.
import { existsSync, readFileSync } from "node:fs";
import { ENV, UTF8 } from "../constants.ts";
import { git } from "../git.ts";

export type IntentCommit = { subject: string; body: string };
export type IntentIssue = { number: number; title: string; body: string };

export type IntentCard = {
    source: "pull_request" | "push" | "local";
    title: string;
    body: string;
    commits: IntentCommit[];
    issues: IntentIssue[];
};

const COMMIT_CAP = 20;
const BODY_CAP = 4000;
const ISSUE_CAP = 3;

const ISSUE_REF = /(?:^|[^\w])#(\d+)\b|issues\/(\d+)\b/g;

type GithubEvent = {
    pull_request?: { title?: string; body?: string | null };
    head_commit?: { message?: string };
};

/** Issue numbers mentioned in a title, body, or commit. Order is first-seen, duplicates dropped. */
export function issueRefs(text: string): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const match of text.matchAll(ISSUE_REF)) {
        const raw = match[1] ?? match[2] ?? "";
        const number = Number(raw);
        if (!Number.isSafeInteger(number) || number < 1 || seen.has(number)) {
            continue;
        }
        seen.add(number);
        out.push(number);
    }
    return out;
}

export function renderIntent(card: IntentCard): string {
    const commits = card.commits.length
        ? card.commits.map((item) => `- ${item.subject}${item.body ? "\n  " + item.body.replace(/\n/g, "\n  ") : ""}`)
        : ["- (none)"];
    const issues = card.issues.length
        ? card.issues.map((item) => `- #${item.number} ${item.title}\n  ${item.body.replace(/\n/g, "\n  ")}`)
        : ["- (none)"];
    return [
        `Source: ${card.source}`,
        `Title: ${card.title || "(none)"}`,
        "Body:",
        card.body || "(none)",
        "Commits:",
        ...commits,
        "Linked issues:",
        ...issues,
    ].join("\n");
}

function clip(text: string, limit: number): string {
    const trimmed = text.trim();
    return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit);
}

/** `git log base..head`, capped. A missing base or a git failure yields an empty list, not a thrown review. */
export function commitLog(root: string, base: string, head: string): IntentCommit[] {
    const range = base ? `${base}..${head}` : head;
    let out = "";
    try {
        out = git(root, ["log", "--format=%x1e%s%x1f%b", "-n", String(COMMIT_CAP), range]);
    } catch {
        return [];
    }
    const commits: IntentCommit[] = [];
    for (const chunk of out.split("\x1e")) {
        if (!chunk.trim()) {
            continue;
        }
        const [subject, body = ""] = chunk.split("\x1f");
        commits.push({ subject: clip(subject ?? "", 200), body: clip(body, 500) });
        if (commits.length >= COMMIT_CAP) {
            break;
        }
    }
    return commits;
}

export type IssueLookup = (number: number) => Promise<{ title: string; body: string } | undefined>;

/**
 * Build the card from the GitHub event file (when Actions provides one) and git log.
 * Issue bodies are filled by `lookup` when the caller has a token. A lookup failure leaves
 * the number with an empty body; the review still runs.
 */
export async function loadIntent(root: string, base: string, head: string, lookup?: IssueLookup): Promise<IntentCard> {
    const path = process.env[ENV.githubEventPath];
    const event: GithubEvent = path && existsSync(path) ? JSON.parse(readFileSync(path, UTF8)) : {};
    const pull = event.pull_request;
    const source: IntentCard["source"] = pull ? "pull_request" : event.head_commit ? "push" : "local";
    const pushMessage = event.head_commit?.message ?? "";
    const title = clip(pull?.title ?? pushMessage.split("\n")[0] ?? "", 300);
    const body = clip(
        pull?.body ?? (pushMessage.includes("\n") ? pushMessage.slice(pushMessage.indexOf("\n") + 1) : ""),
        BODY_CAP,
    );
    const commits = commitLog(root, base, head);
    const blob = [title, body, ...commits.map((item) => item.subject + "\n" + item.body)].join("\n");
    const numbers = issueRefs(blob).slice(0, ISSUE_CAP);
    const issues: IntentIssue[] = [];
    for (const number of numbers) {
        let titleText = "";
        let bodyText = "";
        if (lookup) {
            try {
                const found = await lookup(number);
                titleText = clip(found?.title ?? "", 300);
                bodyText = clip(found?.body ?? "", 2000);
            } catch {
                titleText = "";
                bodyText = "";
            }
        }
        issues.push({ number, title: titleText, body: bodyText });
    }
    return { source, title, body, commits, issues };
}
