// Deterministic evidence check for code CR. A candidate that asks a person to decide, or that quotes
// text which is not in the diff or the file, never reaches a verifier and can never be confirmed.
import type { Candidate } from "./tools.ts";

/**
 * Hands the decision back to a person. A review that asks the reader to confirm, to answer, or to check
 * whether the context is right did not check it. Matched against the title, the message and the evidence.
 */
const DEFERS =
    /请\s*(你|用户|维护者|作者|大家)?\s*(确认|检查|查看|核对|回答|判断|看一下)|是否正确|是否属实|上下文是否|需要\s*(人工|你|用户)|麻烦\s*(确认|看看|看一下)|帮忙看一下|please\s+(confirm|check|verify|review|answer)|could you\s+(check|confirm|verify)|is this\s+(correct|intended|right)|let me know if|you should (check|verify)|需要再看|请自行/i;

/** Shortest quote that can be checked. A shorter span matches too much and proves nothing. */
const MIN_QUOTE = 8;

export function defersToUser(text: string): boolean {
    return DEFERS.test(text);
}

/** Backtick spans long enough to be a quote of code, not a one-word gesture. */
export function quotesOf(text: string): string[] {
    return [...text.matchAll(/`([^`\n]+)`/g)]
        .map((match) => match[1].trim())
        .filter((quote) => quote.length >= MIN_QUOTE);
}

/** The hunk as the model should have copied it: drop the line-number gutter and the diff marker. */
function strippedHunk(body: string): string {
    return body
        .split("\n")
        .map((line) => line.replace(/^\s*\d+\|\s?/, "").replace(/^[-+ ]/, ""))
        .join("\n");
}

function holds(quote: string, hunkBody: string, fileText: string | undefined): boolean {
    const needle = quote.trim();
    return hunkBody.includes(needle) || strippedHunk(hunkBody).includes(needle) || (fileText ?? "").includes(needle);
}

export type Ground = { ok: true; quote: string } | { ok: false; reason: string };

/**
 * The candidate must decide the defect itself, and every quote in its evidence must occur in this hunk
 * or in the file at the reviewed commit. The first held quote is what the line comment shows.
 */
export function groundEvidence(
    candidate: Pick<Candidate, "title" | "message" | "evidence">,
    hunkBody: string,
    fileText: string | undefined,
): Ground {
    const blob = candidate.title + "\n" + candidate.message + "\n" + candidate.evidence;
    if (defersToUser(blob)) {
        return {
            ok: false,
            reason: "asks a person to confirm, to answer, or to check whether the context is correct; the review must decide from the code",
        };
    }
    const quotes = quotesOf(candidate.evidence);
    if (quotes.length === 0) {
        return {
            ok: false,
            reason: `evidence has no backtick quote of at least ${MIN_QUOTE} characters copied from the diff or the file`,
        };
    }
    const missing = quotes.find((quote) => !holds(quote, hunkBody, fileText));
    if (missing !== undefined) {
        const shown = missing.length > 80 ? missing.slice(0, 80) + "…" : missing;
        return {
            ok: false,
            reason: `quoted evidence is not in this diff hunk or in the file at the reviewed commit: ${shown}`,
        };
    }
    return { ok: true, quote: quotes[0] };
}
