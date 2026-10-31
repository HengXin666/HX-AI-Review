import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DETAIL_LIMIT, ERROR, REPORT_DIR, REPORT_NAME, TOOL_NAME, TOOL_VERSION, UTF8 } from "../constants.ts";
import type { CrKind } from "./kind.ts";
import type { CodeTrace } from "./trace.ts";
import { sortFindings } from "./finding.ts";
import type { Finding, Patch, Usage } from "./finding.ts";

export type ReviewReport = {
    tool: string;
    version: string;
    repo: string;
    /** What this run reviewed: context files, or the diff itself. */
    kind: CrKind;
    base: string;
    head: string;
    ok: boolean;
    counts: { error: number; warning: number; blocking: number };
    findings: Finding[];
    patches: Patch[];
    usage: Usage;
    durationMs: number;
    stages: Record<string, string>;
    /** AI candidates dropped by the deterministic gate or the verifier, with the reason. */
    rejections: { path: string; title: string; reason: string }[];
    /** Code CR only: assembled diff groups and the evidence check for every candidate. */
    trace?: CodeTrace;
};

export type ReportInput = Omit<ReviewReport, "tool" | "version" | "ok" | "counts" | "findings" | "rejections"> & {
    findings: Finding[];
    rejections?: ReviewReport["rejections"];
};

/** Only new Error findings block; an active repository exemption keeps a finding out of the gate. */
export function isBlocking(finding: Finding): boolean {
    return finding.severity === ERROR && finding.origin === "new" && finding.exemption?.state !== "exempt";
}

export function buildReport(input: ReportInput): ReviewReport {
    const findings = sortFindings(input.findings);
    const error = findings.filter((item) => item.severity === ERROR).length;
    const blocking = findings.filter(isBlocking).length;
    return {
        tool: TOOL_NAME,
        version: TOOL_VERSION,
        ...input,
        rejections: input.rejections ?? [],
        findings,
        ok: findings.length === 0,
        counts: { error, warning: findings.length - error, blocking },
    };
}

export function escapeMd(text: string): string {
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
        `Kind: ${report.kind}`,
        `Range: ${report.base.slice(0, 12)}..${report.head.slice(0, 12)}`,
        `Errors: ${report.counts.error}, warnings: ${report.counts.warning}, blocking: ${report.counts.blocking}`,
        `Patches: ${report.patches.filter((item) => item.applies).length}`,
        ...Object.entries(report.stages).map(([stage, value]) => `Stage ${stage}: ${escapeMd(value)}`),
        `Rejected AI candidates: ${report.rejections.length}`,
        "",
    ];
    const trace = report.trace ? renderTrace(report.trace) : "";
    return head.join("\n") + summarize(report.findings) + trace;
}

function renderTrace(trace: CodeTrace): string {
    const groups = trace.groups.map(
        (group) =>
            `- ${group.id} ${group.path} batch ${group.batch}: ${group.hunks} hunk(s), added ${group.added.join(",")}`,
    );
    const checks = trace.checks.map(
        (check) =>
            `- ${check.verdict} ${check.path}:${check.line} ${escapeMd(check.title)} — ${escapeMd(check.reason)}`,
    );
    return ["", "## Diff groups", ...groups, "", "## Evidence checks", ...checks, ""].join("\n");
}

export function writeReport(root: string, report: ReviewReport): string {
    const dir = join(root, REPORT_DIR);
    mkdirSync(dir, { recursive: true });
    const base = join(dir, REPORT_NAME);
    writeFileSync(base + ".json", JSON.stringify(report, null, 4) + "\n", UTF8);
    writeFileSync(base + ".md", renderMarkdown(report), UTF8);
    return base;
}
