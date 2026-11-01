// What a code review shows while it runs and after it publishes: the diff groups it assembled,
// and the evidence check on every candidate. Context CR does not produce one.
import type { CodeCategory, CodeGrade } from "./finding.ts";

export type CodeAnchor = "added" | "removed" | "exposed";

export type CodeGroupView = {
    id: string;
    path: string;
    hunks: number;
    /** New-side line numbers the diff added in this group. */
    added: number[];
    /** Old-side line numbers the diff removed in this group. */
    removed?: number[];
    /** 1-based finder batch that received this group. 0 when the run never started a session. */
    batch: number;
    /** The pull-request diff for this group, truncated for display. */
    excerpt: string;
};

export type CodeCheck = {
    path: string;
    line: number;
    title: string;
    verdict: "confirmed" | "rejected" | "suppressed";
    reason: string;
    /** A quote that was found in the diff or the file. Absent when the evidence itself was refused. */
    quote?: string;
    grade?: CodeGrade;
    category?: CodeCategory;
    confidence?: number;
    /** LEFT comments on a deleted line. RIGHT comments on a new-side line. */
    side?: "LEFT" | "RIGHT";
    /** Which kind of diff line the comment is anchored to. */
    anchor?: CodeAnchor;
};

export type CodeTrace = {
    groups: CodeGroupView[];
    checks: CodeCheck[];
};

export type ProgressNote = {
    stage: "assemble" | "review" | "verify";
    detail: string;
    trace: CodeTrace;
};
