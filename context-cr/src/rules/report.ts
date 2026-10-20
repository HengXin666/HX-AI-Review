import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR, REPORT_DIR, TOOL_NAME, TOOL_VERSION, UTF8, WARNING } from "../constants.ts";
import { sortFindings } from "../contract/finding.ts";
import type { Finding, Severity } from "../contract/finding.ts";
import { escapeMd, isBlocking } from "../contract/report.ts";
import { RULES_PENDING_NAME, RULES_REPORT_NAME } from "./constants.ts";
import type { Rule } from "./types.ts";

export type RuleSummary = { id: string; severity: Severity; description: string; criteria: string };

export type RulesReport = {
    tool: string;
    version: string;
    base: string;
    head: string;
    ok: boolean;
    counts: { error: number; warning: number; blocking: number; exempt: number };
    rules: RuleSummary[];
    findings: Finding[];
    durationMs: number;
};

export type RulesPaths = { json: string; md: string; pending: string };

export type RulesReportInput = {
    base: string;
    head: string;
    rules: Rule[];
    findings: Finding[];
    durationMs: number;
};

function summarizeRules(rules: Rule[]): RuleSummary[] {
    return rules.map((rule) => ({
        id: rule.id,
        severity: rule.severity,
        description: rule.description,
        criteria: rule.criteria,
    }));
}

/** Aggregate findings into the report shape shared by the md, json and pending-review files. */
export function buildRulesReport(input: RulesReportInput): RulesReport {
    const findings = sortFindings(input.findings);
    const error = findings.filter((item) => item.severity === ERROR).length;
    const exempt = findings.filter((item) => item.exemption?.state === "exempt").length;
    const blocking = findings.filter(isBlocking).length;
    return {
        tool: TOOL_NAME,
        version: TOOL_VERSION,
        base: input.base,
        head: input.head,
        ok: blocking === 0,
        counts: { error, warning: findings.length - error, blocking, exempt },
        rules: summarizeRules(input.rules),
        findings,
        durationMs: input.durationMs,
    };
}

function exemptionCell(finding: Finding): string {
    if (!finding.exemption) {
        return "none";
    }
    return finding.exemption.state + " (" + finding.exemption.path + ")";
}

function rangeLine(report: RulesReport): string {
    return `Range: ${report.base.slice(0, 12) || "(none)"}..${report.head.slice(0, 12)}`;
}

/** Human-readable report: rule table plus one row per finding with criteria and exemption state. */
export function renderRulesMarkdown(report: RulesReport): string {
    const lines = [
        "# " + TOOL_NAME + " rules report",
        "",
        rangeLine(report),
        `Errors: ${report.counts.error}, warnings: ${report.counts.warning}, blocking: ${report.counts.blocking}, exempt: ${report.counts.exempt}`,
        "",
        "## Rules",
        "",
        "| ID | Severity | Criteria |",
        "|---|---|---|",
        ...report.rules.map((rule) => `| ${rule.id} | ${rule.severity} | ${escapeMd(rule.criteria)} |`),
        "",
        "## Findings",
        "",
    ];
    if (report.findings.length === 0) {
        lines.push("No findings.", "");
        return lines.join("\n");
    }
    lines.push("| Severity | Rule | Location | Criteria | Exemption | Message |", "|---|---|---|---|---|---|");
    for (const item of report.findings) {
        const where = escapeMd(item.path) + ":" + item.line;
        const row = [item.severity, item.ruleId, where, escapeMd(item.criteria ?? ""), exemptionCell(item)];
        lines.push("| " + row.join(" | ") + " | " + escapeMd(item.message) + " |");
    }
    lines.push("");
    return lines.join("\n");
}

/** Warnings only, as one checklist file a human or an agent reviews after the blocking gate passes. */
export function renderPendingReview(report: RulesReport): string {
    const warnings = report.findings.filter((item) => item.severity === WARNING);
    const lines = [
        "# Rules warnings pending review",
        "",
        rangeLine(report),
        `Warnings: ${warnings.length}`,
        "",
    ];
    if (warnings.length === 0) {
        lines.push("No warnings.", "");
        return lines.join("\n");
    }
    for (const item of warnings) {
        const exemption = item.exemption
            ? `${item.exemption.state} (${item.exemption.path}: ${item.exemption.reason})`
            : "none";
        lines.push(`- [ ] ${item.ruleId} ${item.path}:${item.line} - ${item.message}`);
        lines.push(`    - criteria: ${item.criteria ?? ""}`);
        lines.push(`    - exemption: ${exemption}`);
    }
    lines.push("");
    return lines.join("\n");
}

/** Write md, json and the warning-only pending-review file, returning their absolute paths. */
export function writeRulesReport(root: string, report: RulesReport): RulesPaths {
    const dir = join(root, REPORT_DIR);
    mkdirSync(dir, { recursive: true });
    const paths = {
        json: join(dir, RULES_REPORT_NAME + ".json"),
        md: join(dir, RULES_REPORT_NAME + ".md"),
        pending: join(dir, RULES_PENDING_NAME + ".md"),
    };
    writeFileSync(paths.json, JSON.stringify(report, null, 4) + "\n", UTF8);
    writeFileSync(paths.md, renderRulesMarkdown(report), UTF8);
    writeFileSync(paths.pending, renderPendingReview(report), UTF8);
    return paths;
}
