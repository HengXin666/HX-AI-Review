import { useEffect, useState } from "react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@hx/ui";
import { ApiError, api } from "../api.ts";
import type { RunReport } from "../api.ts";

type Props = { repo: string; id: string; onClose: () => void };

/**
 * Diff groups and evidence checks for one code review. The report is written when the run finishes,
 * so an in-flight job is still only visible on the pull request until publish.
 */
export function CodeTrace({ repo, id, onClose }: Props) {
    const [report, setReport] = useState<RunReport | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        setReport(null);
        setError(null);
        api.runReport(repo, id).then(
            (next) => {
                if (live) {
                    setReport(next);
                }
            },
            (err: unknown) => {
                if (!live) {
                    return;
                }
                setError(err instanceof ApiError ? err.message : "无法读取报告");
            },
        );
        return () => {
            live = false;
        };
    }, [repo, id]);

    const trace = report?.trace;
    return (
        <Card>
            <CardHeader className="flex flex-row items-center gap-2">
                <CardTitle>代码 CR 进度 · {repo}</CardTitle>
                <button type="button" className="ml-auto text-[length:var(--fs-xs)] text-link" onClick={onClose}>
                    关闭
                </button>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-[length:var(--fs-xs)]">
                {error ? <p className="text-danger-fg">{error}</p> : null}
                {!error && !report ? <p className="text-muted-foreground">读取报告…</p> : null}
                {report && !trace ? (
                    <p className="text-muted-foreground">
                        这次运行没有分组和证据校验记录。上下文 CR 不产生它；更早的代码 CR 需要用新的 runner 重跑。
                    </p>
                ) : null}
                {trace ? (
                    <>
                        <ol className="flex flex-col gap-1 text-muted-foreground">
                            <li>1. 分组组装 · {trace.groups.length} 组</li>
                            <li>2. 分块审查 · {new Set(trace.groups.map((group) => group.batch)).size} 批</li>
                            <li>
                                3. 证据校验 · {trace.checks.filter((check) => check.verdict === "confirmed").length}{" "}
                                确认 / {trace.checks.filter((check) => check.verdict === "rejected").length} 驳回
                            </li>
                        </ol>
                        {trace.groups.map((group) => (
                            <details
                                key={group.id + group.batch}
                                className="rounded-lg border border-border/40 px-2 py-1.5"
                                open
                            >
                                <summary className="cursor-pointer font-mono">
                                    {group.id} {group.path} · 第 {group.batch} 批 · {group.hunks} hunk · 新增{" "}
                                    {group.added.slice(0, 8).join(",")}
                                    {group.added.length > 8 ? "…" : ""}
                                </summary>
                                <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-[length:var(--fs-2xs)]">
                                    {group.excerpt || "（无 diff 正文）"}
                                </pre>
                            </details>
                        ))}
                        <div className="flex flex-col gap-1">
                            {trace.checks.length === 0 ? (
                                <p className="text-muted-foreground">没有候选。diff 里没有被报出的问题。</p>
                            ) : (
                                trace.checks.map((check, index) => (
                                    <div
                                        key={check.path + check.line + index}
                                        className="rounded-lg border border-border/40 px-2 py-1.5"
                                    >
                                        <Badge variant={check.verdict === "confirmed" ? "warning" : "secondary"}>
                                            {check.verdict === "confirmed" ? "确认" : "驳回"}
                                        </Badge>{" "}
                                        <span className="font-mono">
                                            {check.path}:{check.line}
                                        </span>{" "}
                                        {check.title}
                                        {check.quote ? (
                                            <pre className="mt-1 whitespace-pre-wrap font-mono text-[length:var(--fs-2xs)]">
                                                {check.quote}
                                            </pre>
                                        ) : null}
                                        <p className="mt-1 text-muted-foreground">{check.reason}</p>
                                    </div>
                                ))
                            )}
                        </div>
                    </>
                ) : null}
            </CardContent>
        </Card>
    );
}
