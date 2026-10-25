import { LOCAL_REPORT_NAME } from "../constants.ts";
import { EMPTY_USAGE } from "../contract/finding.ts";
import { CONTEXT_KIND } from "../contract/kind.ts";
import type { Finding } from "../contract/finding.ts";
import { buildReport } from "../contract/report.ts";
import type { ReviewReport } from "../contract/report.ts";
import { tryGit } from "../git.ts";
import { writeNamedReport } from "./report.ts";
import type { WrittenReport } from "./report.ts";
import { codeCheck } from "./checks/code.ts";
import { docsCheck } from "./checks/docs.ts";
import type { CheckContext } from "./checks/rules.ts";
import {
    changedPaths,
    existsInWorktree,
    localChanges,
    readAt,
    readWorktree,
    resolveLocalBase,
    trackedInWorktree,
} from "./worktree.ts";

export type LocalResult = {
    report: ReviewReport;
    written: WrittenReport;
    base: string;
    label: string;
    changes: number;
};

/** Build the diff-only check context, run the code and docs checks, and write the MD/JSON report pair. */
export function runLocal(root: string, requestedBase?: string): LocalResult {
    const resolved = resolveLocalBase(root, requestedBase);
    const changes = localChanges(root, resolved.base);
    const tracked = trackedInWorktree(root);
    const ctx: CheckContext = {
        root,
        base: resolved.base,
        changes,
        changed: changedPaths(changes),
        tracked,
        read: (path) => readWorktree(root, path),
        readBase: (path) => readAt(root, resolved.base, path),
        exists: (path) => existsInWorktree(root, path),
    };
    const started = Date.now();
    const findings: Finding[] = [...codeCheck.run(ctx), ...docsCheck.run(ctx)];
    const report = buildReport({
        repo: root,
        // The local checks are context checks: they look at the worktree's context files, not at the diff.
        kind: CONTEXT_KIND,
        base: resolved.base,
        head: tryGit(root, ["rev-parse", "HEAD"])?.trim() ?? "",
        patches: [],
        usage: EMPTY_USAGE,
        durationMs: Date.now() - started,
        stages: { local: resolved.label },
        findings,
    });
    return {
        report,
        written: writeNamedReport(root, LOCAL_REPORT_NAME, report),
        base: resolved.base,
        label: resolved.label,
        changes: changes.length,
    };
}
