// Row mappers from D1 snake_case columns to the port types.
import type {
    FindingRow,
    FindingStatus,
    PromptNote,
    PromptVersion,
    ProviderRow,
    RepoRow,
    RuleSeverity,
    RuleSummary,
    RunRow,
    SeveritySummary,
} from "./port.ts";

export type Row = Record<string, unknown>;

export function repo(row: Row): RepoRow {
    return {
        id: Number(row.id),
        name: String(row.name),
        enabled: Number(row.enabled) === 1,
        mode: row.mode === "l0" ? "l0" : "full",
        provider: String(row.provider),
        finderModel: String(row.finder_model),
        verifierModel: String(row.verifier_model),
        budgetUsd: Number(row.budget_usd),
        spentUsd: Number(row.spent_usd),
        budgetMonth: String(row.budget_month),
        lastSha: row.last_sha === null ? null : String(row.last_sha),
    };
}

export function provider(row: Row): ProviderRow {
    return {
        name: String(row.name),
        apiUrl: String(row.api_url),
        api: row.api === "anthropic-messages" ? "anthropic-messages" : "openai-completions",
        keySecret: String(row.key_secret),
        contextWindow: Number(row.context_window),
        maxTokens: Number(row.max_tokens),
        priceInput: Number(row.price_input),
        priceOutput: Number(row.price_output),
        priceCacheRead: Number(row.price_cache_read),
        priceCacheWrite: Number(row.price_cache_write),
    };
}

export function run(row: Row): RunRow & { repo: string } {
    return {
        id: String(row.id),
        repoId: Number(row.repo_id),
        repo: String(row.repo ?? ""),
        sha: String(row.sha),
        baseSha: String(row.base_sha),
        event: String(row.event),
        prNumber: row.pr_number === null ? null : Number(row.pr_number),
        status: String(row.status),
        l0Only: Number(row.l0_only) === 1,
        errors: Number(row.errors),
        warnings: Number(row.warnings),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        costUsd: Number(row.cost_usd),
        durationMs: Number(row.duration_ms),
        patchBranch: row.patch_branch === null ? null : String(row.patch_branch),
        createdAt: String(row.created_at),
    };
}

export function finding(row: Row): FindingRow & { repo: string } {
    return {
        id: String(row.id),
        runId: String(row.run_id),
        repoId: Number(row.repo_id),
        repo: String(row.repo ?? ""),
        fingerprint: String(row.fingerprint),
        ruleId: String(row.rule_id),
        severity: String(row.severity),
        path: String(row.path),
        line: Number(row.line),
        message: String(row.message),
        evidence: String(row.evidence),
        patchKey: row.patch_key === null || row.patch_key === undefined ? null : String(row.patch_key),
        status: statusOf(row.status),
        resolvedByRun: row.resolved_by_run ? String(row.resolved_by_run) : null,
    };
}

const STATUSES = new Set<FindingStatus>(["open", "accepted", "rejected", "resolved"]);

function statusOf(value: unknown): FindingStatus {
    const status = String(value);
    return STATUSES.has(status as FindingStatus) ? (status as FindingStatus) : "open";
}

const SEVERITIES = new Set<RuleSeverity>(["error", "warning"]);

function severityOf(value: unknown): RuleSeverity {
    const severity = String(value);
    return SEVERITIES.has(severity as RuleSeverity) ? (severity as RuleSeverity) : "error";
}

export function ruleSummary(row: Row): RuleSummary {
    return {
        ruleId: String(row.rule_id),
        total: Number(row.total),
        errors: Number(row.errors),
        warnings: Number(row.warnings),
        open: Number(row.open_count),
        waived: Number(row.waived),
        runs: Number(row.runs),
        files: Number(row.files),
    };
}

export function severitySummary(row: Row): SeveritySummary {
    return {
        severity: severityOf(row.severity),
        total: Number(row.total),
        rules: Number(row.rules),
        waived: Number(row.waived),
    };
}

export function promptVersion(row: Row): PromptVersion {
    return {
        id: Number(row.id),
        role: row.role === "verifier" ? "verifier" : "finder",
        version: Number(row.version),
        body: String(row.body),
        note: String(row.note ?? ""),
        active: Number(row.active) === 1,
        createdAt: String(row.created_at),
    };
}

export function promptNote(row: Row): PromptNote {
    return {
        id: Number(row.id),
        repoId: Number(row.repo_id),
        fingerprint: String(row.fingerprint),
        reason: String(row.reason),
        foldedInto: row.folded_into === null || row.folded_into === undefined ? null : Number(row.folded_into),
        createdAt: String(row.created_at),
    };
}
