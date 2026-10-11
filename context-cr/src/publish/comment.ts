import { COMMENT_MARKER, TOOL_NAME } from "../constants.ts";
import { summarize } from "../contract/report.ts";
import type { ReviewReport } from "../contract/report.ts";

export type CommentLinks = { patchUrl?: string; overviewUrl?: string; runUrl?: string };

/** Comment body for a commit or PR. Uses the shared display rule: over 10 issues lists counts only. */
export function renderComment(report: ReviewReport, links: CommentLinks, note?: string): string {
    const verdict = report.counts.blocking
        ? `${report.counts.blocking} blocking L0 error(s)`
        : report.findings.length
          ? `${report.counts.warning} warning(s), nothing blocking`
          : "no findings";
    const lines = [COMMENT_MARKER, `### ${TOOL_NAME}: ${verdict}`, ""];
    if (note) {
        lines.push(note, "");
    }
    lines.push(summarize(report.findings));
    const applying = report.patches.filter((item) => item.applies).length;
    if (links.patchUrl && applying) {
        lines.push(`Suggested context patch (${applying} file change set): ${links.patchUrl}`);
    }
    if (links.runUrl) {
        lines.push(`Full MD/JSON report: ${links.runUrl}`);
    }
    if (links.overviewUrl) {
        lines.push(`Overview and feedback: ${links.overviewUrl}`);
    }
    return lines.join("\n").trim() + "\n";
}
