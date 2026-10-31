// Code CR scope: the lines a diff adds, changes, or deletes, not the context files around them.
// Design and rationale: docs/decisions/2026-10-25-dual-cr-kind.md.
import { isExcluded } from "../config.ts";
import type { RepoConfig } from "../config.ts";
import type { Change } from "../git.ts";
import { baseName } from "../l0/snapshot.ts";

/**
 * One diff line. `number` is the new-side line (added and context lines).
 * `old` is the old-side line (removed and context lines). A removed line has `old` and no `number`,
 * so a finding on it uses side left and the old number.
 */
export type HunkLine = { raw: string; number?: number; old?: number };

/** One hunk of one file, with its `@@` header, as parsed from the diff. */
export type ParsedHunk = { header: string; lines: HunkLine[] };

/**
 * One hunk as shown to the model. Added and context lines are numbered on the new side.
 * Removed lines are numbered `L<old>` so they can be reported with side left.
 * `lines` is added lines only. `removed` is old-side numbers. `exposed` is new-side context
 * lines in a hunk that also deletes something: the lines a deletion leaves behind.
 */
export type CodeHunk = {
    path: string;
    header: string;
    body: string;
    lines: number[];
    removed: number[];
    exposed: number[];
};

export type CodeScope = { kind: "code"; base: string; head: string; changed: string[]; hunks: CodeHunk[] };

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

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
    let nextNew = 0;
    let nextOld = 0;
    for (const raw of diff.split("\n")) {
        const header = HUNK_HEADER.exec(raw);
        if (header) {
            current = { header: raw, lines: [] };
            hunks.push(current);
            nextOld = Number(header[1]);
            nextNew = Number(header[2]);
            continue;
        }
        if (!current) {
            continue;
        }
        const prefix = raw[0];
        if (prefix === "+") {
            current.lines.push({ raw, number: nextNew++ });
        } else if (prefix === " ") {
            current.lines.push({ raw, number: nextNew++, old: nextOld++ });
        } else if (prefix === "-") {
            // No new-side number. The old number is how a deletion is reported (side left).
            current.lines.push({ raw, old: nextOld++ });
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

function gutter(item: HunkLine): string {
    if (item.raw.startsWith("-") && item.old !== undefined) {
        return "L" + item.old;
    }
    if (item.number !== undefined) {
        return String(item.number);
    }
    return "";
}

function render(path: string, hunk: ParsedHunk): CodeHunk {
    const width = Math.max(1, ...hunk.lines.map((item) => gutter(item).length));
    const body = hunk.lines.map((item) => `${gutter(item).padStart(width)}| ${item.raw}`).join("\n");
    const lines = hunk.lines.flatMap((item) =>
        item.number !== undefined && item.raw.startsWith("+") ? [item.number] : [],
    );
    const removed = hunk.lines.flatMap((item) =>
        item.raw.startsWith("-") && item.old !== undefined ? [item.old] : [],
    );
    // Context lines are reportable only when this hunk also deletes something, so a removed
    // check can be tied to the line it used to protect. A pure addition does not open them.
    const exposed =
        removed.length === 0
            ? []
            : hunk.lines.flatMap((item) =>
                  item.raw.startsWith(" ") && item.number !== undefined ? [item.number] : [],
              );
    return { path, header: hunk.header, body, lines, removed, exposed };
}

/**
 * Diff -> hunks the review can anchor a finding on. `readDiff` returns one file's diff.
 *
 * A hunk is kept when it adds a line or removes one. A deleted file is included: its hunks are
 * old-side lines. An ignored path and a binary patch (no hunk header) still yield nothing.
 * The model can read the rest of each surviving file with the read-only tools.
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
        // An ignored path is vendored or generated content. A deleted file is still reviewed:
        // the defect may be the deletion itself, reported against the old line.
        if (ignored(config, path)) {
            continue;
        }
        for (const hunk of parseHunks(readDiff(path))) {
            const rendered = render(path, hunk);
            if (rendered.lines.length || rendered.removed.length) {
                hunks.push(rendered);
            }
        }
    }
    return { kind: "code", base, head, changed: [...new Set(changed)].sort(), hunks };
}
