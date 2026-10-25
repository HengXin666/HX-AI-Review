// Code CR scope: the lines a diff adds or changes, not the context files around them.
// Design and rationale: docs/decisions/2026-10-25-dual-cr-kind.md.
import { isExcluded } from "../config.ts";
import type { RepoConfig } from "../config.ts";
import type { Change } from "../git.ts";
import { baseName } from "../l0/snapshot.ts";

/** One diff line with the line it lands on in the new file; removed lines have no new-side number. */
export type HunkLine = { raw: string; number?: number };

/** One hunk of one file, with its `@@` header, as parsed from the diff. */
export type ParsedHunk = { header: string; lines: HunkLine[] };

/**
 * One hunk as shown to the model: `body` is the header plus new-side-numbered lines, removed lines left
 * unnumbered. `lines` holds the new-side numbering of the added lines only, so the deterministic gate can
 * refuse a finding that names a line the diff never touched.
 */
export type CodeHunk = { path: string; header: string; body: string; lines: number[] };

export type CodeScope = { kind: "code"; base: string; head: string; changed: string[]; hunks: CodeHunk[] };

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function ignored(config: RepoConfig, path: string): boolean {
    return isExcluded(config, path) || config.scopeIgnore.some((item) => path === item || baseName(path) === item);
}

/**
 * Split one file's diff into hunks. Paths are never parsed out of the headers: the caller already knows the
 * exact path from the NUL-safe change list, so a C-quoted or non-ASCII header cannot be misread.
 */
export function parseHunks(diff: string): ParsedHunk[] {
    const hunks: ParsedHunk[] = [];
    let current: ParsedHunk | undefined;
    let next = 0;
    for (const raw of diff.split("\n")) {
        const header = HUNK_HEADER.exec(raw);
        if (header) {
            current = { header: raw, lines: [] };
            hunks.push(current);
            next = Number(header[1]);
            continue;
        }
        if (!current) {
            continue;
        }
        const prefix = raw[0];
        if (prefix === "+" || prefix === " ") {
            current.lines.push({ raw, number: next++ });
        } else if (prefix === "-") {
            // Removed lines have no line in the new file, so they can never be reported.
            current.lines.push({ raw });
        } else if (prefix === "\\") {
            // "No newline at end of file": kept, unnumbered, and it does not close the hunk.
            current.lines.push({ raw });
        } else {
            // Anything else (the next file's header, trailing blank) ends this hunk.
            current = undefined;
        }
    }
    return hunks;
}

function render(path: string, hunk: ParsedHunk): CodeHunk {
    const last = Math.max(1, ...hunk.lines.map((item) => item.number ?? 0));
    const width = String(last).length;
    const body = hunk.lines
        .map((item) => (item.number === undefined ? " ".repeat(width) : String(item.number).padStart(width)))
        .map((number, index) => `${number}| ${hunk.lines[index].raw}`)
        .join("\n");
    const lines = hunk.lines.flatMap((item) =>
        item.number !== undefined && item.raw.startsWith("+") ? [item.number] : [],
    );
    return { path, header: hunk.header, body, lines };
}

/**
 * Diff -> hunks of added lines. `readDiff` returns one file's diff.
 *
 * A hunk that only removes lines carries nothing reportable against the new file, so it is dropped;
 * deleted files and binary patches yield no hunks at all. The model can still read the rest of each file
 * with the read-only tools.
 */
export function computeCodeScope(
    readDiff: (path: string) => string,
    config: RepoConfig,
    changes: Change[],
    base: string,
    head: string,
): CodeScope {
    const changed = changes.flatMap((item) => (item.oldPath ? [item.path, item.oldPath] : [item.path]));
    const hunks: CodeHunk[] = [];
    for (const path of new Set(changes.map((item) => item.path))) {
        // A deleted file has no new side to review; an ignored path is vendored or generated content.
        if (ignored(config, path) || changes.some((item) => item.path === path && item.status.startsWith("D"))) {
            continue;
        }
        for (const hunk of parseHunks(readDiff(path))) {
            const rendered = render(path, hunk);
            if (rendered.lines.length) {
                hunks.push(rendered);
            }
        }
    }
    return { kind: "code", base, head, changed: [...new Set(changed)].sort(), hunks };
}
