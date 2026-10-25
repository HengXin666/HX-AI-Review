// What the models see of each context file: numbered lines, split into byte-bounded finder batches.
import type { CodeHunk } from "../scope/code.ts";
import type { ScopeEntry } from "../scope/index.ts";

export type ContextDoc = { path: string; reasons: string[]; lines: string[] };

/** Numbered so the model reports real line numbers instead of guessing. */
export function numbered(lines: string[], from = 1, to = lines.length): string {
    const width = String(to).length;
    return lines
        .slice(from - 1, to)
        .map((line, index) => `${String(from + index).padStart(width)}| ${line}`)
        .join("\n");
}

/** Readable docs, plus the in-scope paths that could not be read (symlinks, vanished files). */
export function loadDocs(entries: ScopeEntry[], read: (path: string) => string | undefined) {
    const docs: ContextDoc[] = [];
    const unreadable: string[] = [];
    for (const entry of entries) {
        const text = read(entry.path);
        if (text === undefined) {
            unreadable.push(entry.path);
        } else {
            // One trailing newline is a terminator, not an extra empty line: otherwise the finder could
            // report a line past the real end of the file and still pass the line gate.
            const body = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
            docs.push({ path: entry.path, reasons: entry.reasons, lines: body.split("\n") });
        }
    }
    return { docs, unreadable };
}

/**
 * Greedy batches under a byte budget so one finder session never gets more context than it can read
 * carefully. A single file larger than the budget gets a batch of its own and is shown truncated;
 * the finder can still open the rest with the read tool.
 */
export function batchDocs(docs: ContextDoc[], budget: number): ContextDoc[][] {
    const batches: ContextDoc[][] = [];
    let current: ContextDoc[] = [];
    let size = 0;
    for (const doc of docs) {
        // Measured as shown to the model, line-number prefixes included.
        const bytes = Buffer.byteLength(numbered(doc.lines), "utf8");
        if (current.length && size + bytes > budget) {
            batches.push(current);
            current = [];
            size = 0;
        }
        current.push(doc);
        size += bytes;
    }
    if (current.length) {
        batches.push(current);
    }
    return batches;
}

/** The lines around a reported line, for the verifier. */
export function excerpt(doc: ContextDoc, line: number, radius: number): string {
    const from = Math.max(1, line - radius);
    const to = Math.min(doc.lines.length, line + radius);
    return numbered(doc.lines, from, to);
}
/**
 * Greedy batches of hunks under the same byte budget, so one code finder session never gets more diff than
 * it can read carefully. A single hunk larger than the budget gets a batch of its own and is shown truncated.
 */
export function batchHunks(hunks: CodeHunk[], budget: number): CodeHunk[][] {
    const batches: CodeHunk[][] = [];
    let current: CodeHunk[] = [];
    let size = 0;
    for (const hunk of hunks) {
        // Measured as shown: the header, the line numbers and the fence the prompt adds around it.
        const bytes = Buffer.byteLength(hunk.header + "\n" + hunk.body, "utf8");
        if (current.length && size + bytes > budget) {
            batches.push(current);
            current = [];
            size = 0;
        }
        current.push(hunk);
        size += bytes;
    }
    if (current.length) {
        batches.push(current);
    }
    return batches;
}
