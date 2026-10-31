import { Badge, Card, CardContent, CardHeader, CardTitle, DataTable } from "@hx/ui";
import type { DataTableColumn } from "@hx/ui";
import { kindOf, patchBranchUrl } from "../api.ts";
import type { Run } from "../api.ts";
import { dateTime, duration, shortSha, usd } from "../format.ts";
import { kindLabel, kindVariant, matchesKind } from "../kind.ts";
import type { KindFilter } from "../kind.ts";
import { statusLabel, statusVariant } from "../status.ts";

export function runColumns(): DataTableColumn<Run>[] {
    return [
        {
            key: "repo",
            header: "仓库",
            width: "15rem",
            render: (row) => <span className="font-mono text-[length:var(--fs-xs)]">{row.repo}</span>,
        },
        {
            key: "kind",
            header: "类型",
            width: "7rem",
            render: (row) => <Badge variant={kindVariant(kindOf(row.kind))}>{kindLabel(kindOf(row.kind))}</Badge>,
        },
        {
            key: "sha",
            header: "提交",
            width: "9rem",
            render: (row) => (
                <span className="font-mono text-[length:var(--fs-xs)]">
                    {shortSha(row.sha)}
                    {row.prNumber ? " #" + row.prNumber : ""}
                </span>
            ),
        },
        { key: "event", header: "事件", width: "7rem" },
        {
            key: "status",
            header: "状态",
            width: "7rem",
            render: (row) => <Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>,
        },
        {
            key: "counts",
            header: "错误 / 告警",
            width: "8rem",
            numeric: true,
            render: (row) => (
                <span>
                    <span className={row.errors > 0 ? "text-danger-fg" : "text-muted-foreground"}>{row.errors}</span>
                    <span className="text-muted-foreground"> / </span>
                    <span className={row.warnings > 0 ? "text-warning-fg" : "text-muted-foreground"}>
                        {row.warnings}
                    </span>
                </span>
            ),
        },
        { key: "cost", header: "花费", width: "6rem", numeric: true, render: (row) => usd(row.costUsd, 3) },
        { key: "duration", header: "耗时", width: "6rem", numeric: true, render: (row) => duration(row.durationMs) },
        { key: "created", header: "时间", width: "8rem", render: (row) => dateTime(row.createdAt) },
        {
            key: "patch",
            header: "补丁",
            width: "6rem",
            render: (row) =>
                row.patchBranch ? (
                    <a
                        className="text-link underline-offset-4 hover:underline"
                        href={patchBranchUrl(row.repo, row.patchBranch)}
                        target="_blank"
                        rel="noreferrer"
                    >
                        合并
                    </a>
                ) : (
                    <span className="text-muted-foreground">-</span>
                ),
        },
    ];
}

type Props = { runs: Run[]; filter: KindFilter; maxHeight?: string; compact?: boolean; onOpen?: (id: string) => void };

/** Recent runs, narrowed by the kind filter. A row opens that run's review. Code CR has no patch branch. */
export function Runs({ runs, filter, maxHeight = "34rem", compact = false, onOpen }: Props) {
    const rows = runs.filter((row) => matchesKind(row, filter));
    const columns = compact
        ? runColumns().filter((column) => ["repo", "kind", "status", "counts", "created"].includes(column.key))
        : runColumns();
    return (
        <Card>
            <CardHeader className="flex flex-row items-center gap-2">
                <CardTitle>审查 ({rows.length})</CardTitle>
                <span className="ml-auto text-[length:var(--fs-2xs)] text-muted-foreground">点开一行看这次审查</span>
            </CardHeader>
            <CardContent className="px-0 pb-0">
                <DataTable
                    bare
                    maxHeight={maxHeight}
                    rowKey={(row) => row.id}
                    onRowClick={onOpen ? (row) => onOpen(row.id) : undefined}
                    rows={rows}
                    columns={columns}
                    emptyText={filter === "all" ? "暂无运行记录" : "该类型暂无运行记录"}
                />
            </CardContent>
        </Card>
    );
}
