// Extra finder context: import edges among the diff, callers, and recent related PRs and issues.
import { git, isNoMatch } from "../git.ts";
import type { GithubTarget } from "../publish/github.ts";

const IMPORT_RE = /(?:from\s+|import\s*\(?|require\s*\(\s*|#include\s+)["']([^"']+)["']/g;
const PACK_BYTES = 8000;
const SCAN_FILES = 20;
const EDGES = 12;
const CALLERS = 8;

export type Discussion = { kind: "pr" | "issue"; number: number; title: string; updated: string };

function uniq(values: string[], limit: number): string[] {
    return [...new Set(values)].slice(0, limit);
}

/** Specifiers a file imports. Relative specifiers are the call-graph edges; the rest are dependencies. */
export function importsOf(text: string): string[] {
    return uniq(
        [...text.matchAll(IMPORT_RE)].map((match) => match[1] ?? "").filter((item) => item.length > 0),
        EDGES,
    );
}

/** Files that mention a changed path's basename. git exit 1 means nobody mentions it. */
export function callerPaths(root: string, path: string): string[] {
    const base = path.split("/").pop() ?? "";
    if (base.length < 3) {
        return [];
    }
    try {
        const out = git(root, ["grep", "-l", "-I", "-F", base, "--", "."]);
        return uniq(
            out
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line && line !== path),
            CALLERS,
        );
    } catch (error) {
        return isNoMatch(error) ? [] : [];
    }
}

export function renderGraph(
    changed: string[],
    files: { path: string; text: string }[],
    callers: Map<string, string[]>,
): string {
    const lines = ["Changed-file imports and callers (local graph, not a full program analysis):"];
    for (const file of files) {
        const specs = importsOf(file.text);
        const local = specs.filter((item) => item.startsWith("."));
        const external = specs.filter((item) => !item.startsWith("."));
        const mentioned = callers.get(file.path) ?? [];
        lines.push(`- ${file.path}`);
        if (local.length) {
            lines.push(`  imports: ${local.join(", ")}`);
        }
        if (external.length) {
            lines.push(`  dependencies: ${external.join(", ")}`);
        }
        if (mentioned.length) {
            lines.push(`  mentioned by: ${mentioned.join(", ")}`);
        }
    }
    if (files.length < changed.length) {
        lines.push(`- ${changed.length - files.length} further changed path(s) omitted from the graph`);
    }
    return lines.join("\n");
}

export function renderDiscussions(kind: "pr" | "issue", items: Discussion[]): string {
    const title = kind === "pr" ? "Recent pull requests" : "Recent issues";
    if (!items.length) {
        return `${title}: none`;
    }
    return [title + ":", ...items.map((item) => `- #${item.number} ${item.title} (updated ${item.updated})`)].join(
        "\n",
    );
}

async function search(target: GithubTarget, query: string, limit: number, kind: "pr" | "issue"): Promise<Discussion[]> {
    const url = new URL(target.apiUrl.replace(/\/$/, "") + "/search/issues");
    url.searchParams.set("q", query);
    url.searchParams.set("sort", "updated");
    url.searchParams.set("per_page", String(limit));
    const response = await fetch(url, {
        headers: { authorization: "Bearer " + target.token, accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
        throw new Error(`GitHub search failed: ${response.status}`);
    }
    const body = (await response.json()) as { items?: { number?: number; title?: string; updated_at?: string }[] };
    return (body.items ?? []).slice(0, limit).map((item) => ({
        kind,
        number: item.number ?? 0,
        title: item.title ?? "",
        updated: (item.updated_at ?? "").slice(0, 10),
    }));
}

function queryFor(repo: string, kind: "pr" | "issue", paths: string[]): string {
    const terms = uniq(
        paths.map((path) => path.split("/").pop() ?? path).filter((name) => name.length >= 3),
        8,
    ).map((name) => `"${name.replaceAll('"', "")}"`);
    const clause = terms.length ? ` (${terms.join(" OR ")})` : "";
    return `repo:${repo} is:${kind}${clause}`;
}

export async function relatedDiscussions(
    target: GithubTarget | undefined,
    paths: string[],
    limits: { prs: number; issues: number },
): Promise<{ prs: Discussion[]; issues: Discussion[]; note: string }> {
    if (!target || (limits.prs === 0 && limits.issues === 0)) {
        return { prs: [], issues: [], note: "" };
    }
    const [prsResult, issuesResult] = await Promise.allSettled([
        limits.prs > 0 ? search(target, queryFor(target.repo, "pr", paths), limits.prs, "pr") : Promise.resolve([]),
        limits.issues > 0 ? search(target, queryFor(target.repo, "issue", paths), limits.issues, "issue") : Promise.resolve([]),
    ]);
    const prs = prsResult.status === "fulfilled" ? prsResult.value : [];
    const issues = issuesResult.status === "fulfilled" ? issuesResult.value : [];
    const failed = [prsResult, issuesResult].filter((result) => result.status === "rejected");
    return {
        prs,
        issues,
        note: failed.length
            ? `recent discussions unavailable: ${failed.map((result) => String(result.reason)).join("; ")}`
            : "",
    };
}

/** Bounded text the finder may quote. Empty when there is nothing to add. */
export async function buildEvidencePack(input: {
    root: string;
    changed: string[];
    readFile(path: string): string | undefined;
    github?: GithubTarget;
    prs: number;
    issues: number;
}): Promise<string> {
    const changed = input.changed.slice(0, SCAN_FILES);
    const files = changed.flatMap((path) => {
        const text = input.readFile(path);
        return text === undefined ? [] : [{ path, text }];
    });
    const callers = new Map(files.map((file) => [file.path, callerPaths(input.root, file.path)]));
    const history = await relatedDiscussions(input.github, input.changed, { prs: input.prs, issues: input.issues });
    const parts = [
        renderGraph(input.changed, files, callers),
        renderDiscussions("pr", history.prs),
        renderDiscussions("issue", history.issues),
        history.note,
    ].filter((part) => part.length > 0);
    const text = parts.join("\n\n");
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= PACK_BYTES) {
        return text;
    }
    return (
        bytes
            .subarray(0, PACK_BYTES)
            .toString("utf8")
            .replace(/\uFFFD+$/, "") + "\n... evidence truncated\n"
    );
}
