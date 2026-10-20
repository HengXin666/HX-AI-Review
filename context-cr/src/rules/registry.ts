import { ERROR, RULE } from "../constants.ts";
import { makeFinding, sortFindings } from "../contract/finding.ts";
import type { Finding } from "../contract/finding.ts";
import { exemptionRef } from "./exemptions.ts";
import type { Rule, RuleContext, RuleIssue } from "./types.ts";

const REGISTRY = new Map<string, Rule>();

/** Register one rule; a duplicate id is a programming error and fails loudly. */
export function registerRule(rule: Rule): void {
    if (REGISTRY.has(rule.id)) {
        throw new Error(`rule ${rule.id} is registered twice`);
    }
    REGISTRY.set(rule.id, rule);
}

/** Registered rules in id order, so reports are stable. */
export function registeredRules(): Rule[] {
    return [...REGISTRY.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function toFinding(ctx: RuleContext, rule: Rule, issue: RuleIssue): Finding {
    const severity = issue.severity ?? rule.severity;
    const meta = {
        criteria: issue.criteria ?? rule.criteria,
        exemption: exemptionRef(ctx, rule.id, issue.path),
    };
    return makeFinding(
        rule.id,
        severity,
        issue.path,
        issue.line,
        issue.message,
        issue.evidence ?? "",
        issue.anchor ?? issue.message,
        meta,
    );
}

/**
 * Run every rule without short-circuiting; a crashing rule becomes a tool-error instead of a pass.
 * Exemptions are resolved per finding so an active one keeps an Error out of the gate.
 */
export function runRules(ctx: RuleContext, rules: Rule[] = registeredRules()): Finding[] {
    const findings: Finding[] = [];
    for (const rule of rules) {
        try {
            for (const issue of rule.check(ctx)) {
                findings.push(toFinding(ctx, rule, issue));
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const message = `${rule.id} crashed: ${reason}`;
            findings.push(
                makeFinding(RULE.tool, ERROR, ".", 1, message, rule.id, rule.id, { criteria: rule.criteria }),
            );
        }
    }
    return sortFindings(findings);
}
