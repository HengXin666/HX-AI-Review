import type { Finding, Kind, Overview, RepoKind, Run } from "./api.ts";
import { kindOf } from "./api.ts";

/** Which kinds the overview shows. "all" is the unfiltered view. */
export type KindFilter = "all" | Kind;

export const KIND_FILTER_ITEMS: { key: KindFilter; label: string }[] = [
    { key: "all", label: "全部" },
    { key: "context", label: "上下文 CR" },
    { key: "code", label: "代码 CR" },
];

export function kindLabel(kind: Kind): string {
    return kind === "code" ? "代码 CR" : "上下文 CR";
}

/** A repo may serve one kind or both, so it needs its own label. */
export function repoKindLabel(kind: RepoKind): string {
    if (kind === "both") {
        return "两种";
    }
    return kindLabel(kind);
}

export function repoKindOf(kind: unknown): RepoKind {
    return kind === "code" || kind === "both" ? kind : "context";
}

/** Badge variant for a kind: code reviews are the newer surface and read as the accent one. */
export function kindVariant(kind: Kind): "default" | "secondary" {
    return kind === "code" ? "default" : "secondary";
}

export function matchesKind(row: { kind?: Kind }, filter: KindFilter): boolean {
    return filter === "all" || kindOf(row.kind) === filter;
}

/**
 * Rule namespaces are part of the contract: HC-* and CX-* belong to context reviews, CODE-* to code
 * reviews. Rule aggregates carry no kind column, so the namespace is the only signal on that screen.
 */
export function ruleKind(ruleId: string): Kind {
    return ruleId.startsWith("CODE-") ? "code" : "context";
}

export type Totals = {
    errors: number;
    warnings: number;
    open: number;
    spendUsd: number;
    runs: number;
    contextRuns: number;
    codeRuns: number;
    budgetUsd: number;
    repos: number;
};

function countBy<T>(rows: readonly T[], pick: (row: T) => string, value: string): number {
    return rows.filter((row) => pick(row) === value).length;
}

/** Headline numbers for the current kind filter. Pending findings and runs are both narrowed by it. */
export function totals(data: Overview, filter: KindFilter): Totals {
    const findings = data.findings.filter((row: Finding) => matchesKind(row, filter));
    const runs = data.runs.filter((row: Run) => matchesKind(row, filter));
    return {
        errors: countBy(findings, (row) => row.severity, "error"),
        warnings: countBy(findings, (row) => row.severity, "warning"),
        open: findings.length,
        spendUsd: data.repos.reduce((sum, repo) => sum + repo.spentUsd, 0),
        runs: runs.length,
        contextRuns: countBy(runs, (row) => kindOf(row.kind), "context"),
        codeRuns: countBy(runs, (row) => kindOf(row.kind), "code"),
        budgetUsd: data.repos.reduce((sum, repo) => sum + repo.budgetUsd, 0),
        repos: data.repos.length,
    };
}
