import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DETAIL_LIMIT, ERROR, REPORT_DIR, REPORT_NAME, TOOL_NAME, TOOL_VERSION, UTF8 } from "../constants.ts";
import { sortFindings } from "./finding.ts";
import type { Finding, Patch, Usage } from "./finding.ts";

export type ReviewReport = {
    tool: string;
    version: string;
    repo: string;
    base: string;
    head: string;
    ok: boolean;
    counts: { error: number; warning: number; blocking: number };
    findings: Finding[];
    patches: Patch[];
    usage: Usage;
    durationMs: number;
    stages: Record<string, string>;
};

export type ReportInput = Omit<ReviewReport, "tool" | "version" | "ok" | "counts" | "findings"> & {
    findings: Finding[];
};

/** Only new Error findings block, matching hx-agent-code baseline semantics. */
export function isBlocking(finding: Finding): boolean {
    return finding.severity === ERROR && finding.origin === "new";
}

export function buildReport(input: ReportInput): ReviewReport {
    const findings = sortFindings(input.findings);
    const error = findings.filter((item) => item.severity === ERROR).length;
    const blocking = findings.filter(isBlocking).length;
    return {
        tool: TOOL_NAME,
        version: TOOL_VERSION,
        ...input,
        findings,
        ok: findings.length === 0,
        counts: { error, warning: findings.length - error, blocking },
    };
}

function escapeMd(text: string): string {
    return text.replace(/([\\`*_[\]|<>])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

/** Same display rule as hx-agent-code: more than DETAIL_LIMIT issues shows counts by type only. */
export function summarize(findings: Finding[]): string {
    if (findings.length === 0) {
        return "No findings.\n";
    }
    const byRule = new Map<string, number>();
    for (const item of findings) {
        const key = item.severity + " " + item.ruleId;
        byRule.set(key, (byRule.get(key) ?? 0) + 1);
    }
    const lines = ["Total: " + findings.length, ""];
    for (const [key, count] of [...byRule.entries()].sort()) {
        lines.push("- " + key + ": " + count);
    }
    if (findings.length <= DETAIL_LIMIT) {
        lines.push("", "| Severity | Rule | Location | Message |", "|---|---|---|---|");
        for (const item of findings) {
            const where = escapeMd(item.path) + ":" + item.line;
            lines.push(`| ${item.severity} | ${item.ruleId} | ${where} | ${escapeMd(item.message)} |`);
        }
    }
    return lines.join("\n") + "\n";
}

export function renderMarkdown(report: ReviewReport): string {
    const head = [
        "# " + TOOL_NAME + " report",
        "",
        `Range: ${report.base.slice(0, 12)}..${report.head.slice(0, 12)}`,
        `Errors: ${report.counts.error}, warnings: ${report.counts.warning}, blocking: ${report.counts.blocking}`,
        `Patches: ${report.patches.filter((item) => item.applies).length}`,
        "",
    ];
    return head.join("\n") + summarize(report.findings);
}

export function writeReport(root: string, report: ReviewReport): string {
    const dir = join(root, REPORT_DIR);
    mkdirSync(dir, { recursive: true });
    const base = join(dir, REPORT_NAME);
    writeFileSync(base + ".json", JSON.stringify(report, null, 4) + "\n", UTF8);
    writeFileSync(base + ".md", renderMarkdown(report), UTF8);
    return base;
}
