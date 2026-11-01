// Pure view of one run. The worker stores findings, not the diff, so the page can show
// stages, directory groups and evidence quotes, and has to link out for the actual hunk.

export type StageStatus = "pending" | "active" | "done" | "error";

export type Stage = {
    id: string;
    title: string;
    description: string;
    status?: StageStatus;
};

export type ReviewGroup<T> = {
    name: string;
    files: { path: string; findings: T[] }[];
};

const CODE_STAGES: Stage[] = [
    { id: "diff", title: "读取 diff", description: "新增行、删除行，以及删除留下的上下文" },
    { id: "group", title: "分组", description: "按目录聚合这次发现" },
    { id: "chunk", title: "分块审查", description: "每一组单独出发现" },
    { id: "prove", title: "证据校验", description: "引用写在发现里，不叫人自己去对" },
    { id: "line", title: "钉到行上", description: "行评在 PR 上，这里链到同一行" },
];

const CONTEXT_STAGES: Stage[] = [
    { id: "l0", title: "L0 检查", description: "确定性规则，错误从这里来" },
    { id: "read", title: "对照上下文", description: "上下文文件是否还成立" },
    { id: "check", title: "证据校验", description: "发现要带引用，不把核对丢给看的人" },
    { id: "patch", title: "补丁", description: "只改上下文文件" },
];

export function hasEvidence(finding: { evidence?: string }): boolean {
    return Boolean(finding.evidence?.trim());
}

/** First path segment. A file at the repo root has no directory, so it gets its own bucket. */
export function groupByDirectory<T extends { path: string }>(findings: readonly T[]): ReviewGroup<T>[] {
    const dirs = new Map<string, Map<string, T[]>>();
    for (const finding of findings) {
        const slash = finding.path.indexOf("/");
        const name = slash === -1 ? "(根目录)" : finding.path.slice(0, slash);
        const files = dirs.get(name) ?? new Map<string, T[]>();
        const rows = files.get(finding.path) ?? [];
        rows.push(finding);
        files.set(finding.path, rows);
        dirs.set(name, files);
    }
    return [...dirs.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, files]) => ({
            name,
            files: [...files.entries()]
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([path, rows]) => ({ path, findings: rows })),
        }));
}

/**
 * Stage bar for one finished or unfinished run.
 *
 * The runner does not report which step it stopped on, so a live run stays on the first step,
 * a missing evidence quote fails the check step, and a clean run marks every step done.
 */
export function stagesFor(
    kind: "code" | "context",
    status: string,
    missingEvidence: number,
): { stages: Stage[]; current: number } {
    const base = (kind === "code" ? CODE_STAGES : CONTEXT_STAGES).map((stage) => ({ ...stage }));
    const proveIndex = base.findIndex((stage) => stage.id === "prove" || stage.id === "check");
    if (status === "incomplete" || status === "skipped") {
        return { stages: base, current: 0 };
    }
    if (missingEvidence > 0) {
        const prove = base[proveIndex];
        if (prove) {
            prove.status = "error";
        }
        return { stages: base, current: proveIndex };
    }
    if (status === "failed") {
        const last = base[base.length - 1];
        if (last) {
            last.status = "error";
        }
        return { stages: base, current: base.length - 1 };
    }
    return { stages: base, current: base.length };
}

export function lineUrl(repo: string, sha: string, path: string, line: number): string {
    const encoded = path
        .replace(/^\/+/, "")
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");
    return `https://github.com/${repo}/blob/${encodeURIComponent(sha)}/${encoded}#L${line}`;
}

export function pullUrl(repo: string, pr: number): string {
    return `https://github.com/${repo}/pull/${pr}`;
}
