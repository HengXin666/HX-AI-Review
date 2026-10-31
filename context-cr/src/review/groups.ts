// Assemble a code-review diff into file groups, then pack those groups into finder batches.
// A group is every hunk of one file, in diff order: that is the change, not a byte slice of mixed files.
import type { CodeGroupView } from "../contract/trace.ts";
import type { CodeHunk } from "../scope/code.ts";

export type DiffGroup = {
    id: string;
    path: string;
    hunks: CodeHunk[];
    added: number[];
};

const EXCERPT_LINES = 40;

function weight(hunk: CodeHunk): number {
    return Buffer.byteLength(hunk.header + "\n" + hunk.body, "utf8");
}

/** One group per changed file. Hunk order inside the file is the diff order. */
export function assembleFileGroups(hunks: CodeHunk[]): DiffGroup[] {
    const order: string[] = [];
    const byPath = new Map<string, CodeHunk[]>();
    for (const hunk of hunks) {
        const list = byPath.get(hunk.path);
        if (list) {
            list.push(hunk);
        } else {
            order.push(hunk.path);
            byPath.set(hunk.path, [hunk]);
        }
    }
    return order.map((path, index) => {
        const fileHunks = byPath.get(path) as CodeHunk[];
        return {
            id: "g" + (index + 1),
            path,
            hunks: fileHunks,
            added: fileHunks.flatMap((hunk) => hunk.lines),
        };
    });
}

function asGroup(id: string, path: string, hunks: CodeHunk[]): DiffGroup {
    return { id, path, hunks, added: hunks.flatMap((hunk) => hunk.lines) };
}

/**
 * Pack whole file groups into batches under `budget` bytes. A group that is itself over the budget is
 * split by hunk and is never mixed into another file's batch, so a finder session still sees one change.
 */
export function batchGroups(groups: DiffGroup[], budget: number): DiffGroup[][] {
    const batches: DiffGroup[][] = [];
    let current: DiffGroup[] = [];
    let size = 0;
    const flush = () => {
        if (current.length) {
            batches.push(current);
        }
        current = [];
        size = 0;
    };
    for (const group of groups) {
        const bytes = group.hunks.reduce((sum, hunk) => sum + weight(hunk), 0);
        if (bytes > budget && group.hunks.length > 1) {
            flush();
            let part = 0;
            let slice: CodeHunk[] = [];
            let sliceSize = 0;
            const pushSlice = () => {
                if (!slice.length) {
                    return;
                }
                part += 1;
                batches.push([asGroup(group.id + "." + part, group.path, slice)]);
                slice = [];
                sliceSize = 0;
            };
            for (const hunk of group.hunks) {
                const hunkBytes = weight(hunk);
                if (slice.length && sliceSize + hunkBytes > budget) {
                    pushSlice();
                }
                slice.push(hunk);
                sliceSize += hunkBytes;
            }
            pushSlice();
            continue;
        }
        if (current.length && size + bytes > budget) {
            flush();
        }
        current.push(group);
        size += bytes;
    }
    flush();
    return batches;
}

/** The diff a person can read in the PR comment and the overview. Long groups are cut, not dropped. */
export function groupExcerpt(group: DiffGroup, maxLines = EXCERPT_LINES): string {
    const text = group.hunks.map((hunk) => hunk.header + "\n" + hunk.body).join("\n");
    const lines = text.split("\n");
    if (lines.length <= maxLines) {
        return text;
    }
    return lines.slice(0, maxLines).join("\n") + `\n... ${lines.length - maxLines} more diff lines`;
}

export function groupViews(batches: DiffGroup[][]): CodeGroupView[] {
    const views: CodeGroupView[] = [];
    batches.forEach((batch, index) => {
        for (const group of batch) {
            views.push({
                id: group.id,
                path: group.path,
                hunks: group.hunks.length,
                added: group.added,
                batch: index + 1,
                excerpt: groupExcerpt(group),
            });
        }
    });
    return views;
}
