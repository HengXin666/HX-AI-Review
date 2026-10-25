import { useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, DataTable, EmptyState, Input } from "@hx/ui";
import type { DataTableColumn } from "@hx/ui";
import { kindOf } from "../api.ts";
import type { Finding } from "../api.ts";
import { kindLabel, kindVariant, matchesKind } from "../kind.ts";
import type { KindFilter } from "../kind.ts";
import { severityLabel, severityVariant } from "../status.ts";

type Props = {
    findings: Finding[];
    resolved: Finding[];
    filter: KindFilter;
    onVerdict: (id: string, verdict: "accepted" | "rejected", reason: string) => void;
};

/**
 * Pending findings with accept/reject, plus the ones a later commit resolved.
 *
 * A code CR finding has no patch to apply (the runner never pushes code patches), so the patch column
 * is empty for it and the suggestion lives in the message.
 */
export function Findings({ findings, resolved, filter, onVerdict }: Props) {
    const [reasons, setReasons] = useState<Record<string, string>>({});
    const pending = findings.filter((row) => matchesKind(row, filter));
    const done = resolved.filter((row) => matchesKind(row, filter));

    const columns: DataTableColumn<Finding>[] = [
        {
            key: "repo",
            header: "仓库",
            width: "11rem",
            render: (row) => <span className="font-mono text-[length:var(--fs-xs)]">{row.repo}</span>,
        },
        {
            key: "kind",
            header: "类型",
            width: "6rem",
            render: (row) => <Badge variant={kindVariant(kindOf(row.kind))}>{kindLabel(kindOf(row.kind))}</Badge>,
        },
        {
            key: "rule",
            header: "规则",
            width: "11rem",
            render: (row) => (
                <span className="flex items-center gap-1.5">
                    <Badge variant={severityVariant(row.severity)}>{severityLabel(row.severity)}</Badge>
                    <span className="font-mono text-[length:var(--fs-xs)]">{row.ruleId}</span>
                </span>
            ),
        },
        {
            key: "where",
            header: "位置",
            width: "13rem",
            render: (row) => (
                <span className="truncate font-mono text-[length:var(--fs-xs)]" title={row.path + ":" + row.line}>
                    {row.path}:{row.line}
                </span>
            ),
        },
        { key: "message", header: "说明", cellClassName: "min-w-56 leading-relaxed" },
        {
            key: "patch",
            header: "补丁",
            width: "4rem",
            render: (row) =>
                row.patchKey ? (
                    <a
                        className="text-link underline-offset-4 hover:underline"
                        href={`/api/findings/${row.id}/patch`}
                        target="_blank"
                        rel="noreferrer"
                    >
                        查看
                    </a>
                ) : (
                    <span className="text-muted-foreground">-</span>
                ),
        },
        {
            key: "verdict",
            header: "处置",
            width: "16rem",
            render: (row) => (
                <span className="flex flex-wrap items-center gap-1">
                    <Input
                        value={reasons[row.id] ?? ""}
                        placeholder="驳回原因"
                        aria-label="驳回原因"
                        className="w-32"
                        onChange={(event) => setReasons((current) => ({ ...current, [row.id]: event.target.value }))}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => onVerdict(row.id, "accepted", "")}>
                        接受
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => onVerdict(row.id, "rejected", reasons[row.id] ?? "")}
                    >
                        驳回
                    </Button>
                </span>
            ),
        },
    ];

    return (
        <>
            <Card>
                <CardHeader className="flex flex-row items-center gap-2">
                    <CardTitle>待处理发现 ({pending.length})</CardTitle>
                    <span className="ml-auto text-[length:var(--fs-2xs)] text-muted-foreground">
                        驳回会写回抑制表与提示词附录
                    </span>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                    {pending.length === 0 ? (
                        <EmptyState
                            compact
                            text="暂无待处理发现"
                            hint={
                                filter === "all" ? "新的运行产出发现后会出现在这里。" : "切换 CR 类型或等待下一次运行。"
                            }
                        />
                    ) : (
                        <DataTable bare maxHeight="38rem" rowKey={(row) => row.id} rows={pending} columns={columns} />
                    )}
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>后续提交已解决 ({done.length})</CardTitle>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                    {done.length === 0 ? (
                        <EmptyState
                            compact
                            text="暂无已解决的发现"
                            hint="同一 PR 的后续提交没有再次报出的发现会落到这里。"
                        />
                    ) : (
                        <DataTable
                            bare
                            maxHeight="24rem"
                            rowKey={(row) => row.id}
                            rows={done}
                            columns={columns.filter((column) => column.key !== "verdict" && column.key !== "patch")}
                        />
                    )}
                </CardContent>
            </Card>
        </>
    );
}
