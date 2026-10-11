// What the models see of each context file: numbered lines, split into byte-bounded finder batches.
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
            docs.push({ path: entry.path, reasons: entry.reasons, lines: text.replace(/\r\n/g, "\n").split("\n") });
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
