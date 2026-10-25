import { Badge, Card, CardContent, CardHeader, CardTitle, DataTable, EmptyState } from "@hx/ui";
import type { DataTableColumn } from "@hx/ui";
import type { RuleStats, RuleSummary } from "../api.ts";
import { kindLabel, kindVariant, ruleKind } from "../kind.ts";
import type { KindFilter } from "../kind.ts";

/** Rule and severity totals over recorded rule results, most frequent rule first. */
export function Rules({ stats, filter }: { stats: RuleStats | null; filter: KindFilter }) {
    if (!stats) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>规则统计</CardTitle>
                </CardHeader>
                <CardContent>
                    <EmptyState
                        compact
                        kind="error"
                        text="规则聚合暂不可用"
                        hint="GET /api/rules 没有返回数据, 稍后重试。"
                    />
                </CardContent>
            </Card>
        );
    }
    // Rule aggregates carry no kind column, so the rule namespace is the only signal: CODE-* is code CR.
    const rows = stats.byRule.filter((row) => filter === "all" || ruleKind(row.ruleId) === filter);
    const columns: DataTableColumn<RuleSummary>[] = [
        {
            key: "rule",
            header: "规则",
            width: "14rem",
            render: (row) => <span className="font-mono text-[length:var(--fs-xs)]">{row.ruleId}</span>,
        },
        {
            key: "kind",
            header: "类型",
            width: "7rem",
            render: (row) => (
                <Badge variant={kindVariant(ruleKind(row.ruleId))}>{kindLabel(ruleKind(row.ruleId))}</Badge>
            ),
        },
        {
            key: "severity",
            header: "等级",
            width: "12rem",
            render: (row) => (
                <span className="flex gap-1">
                    {row.errors ? <Badge variant="destructive">错误 {row.errors}</Badge> : null}
                    {row.warnings ? <Badge variant="warning">告警 {row.warnings}</Badge> : null}
                </span>
            ),
        },
        { key: "total", header: "命中", width: "5rem", numeric: true },
        { key: "open", header: "待处理", width: "6rem", numeric: true },
        { key: "waived", header: "已豁免", width: "6rem", numeric: true },
        { key: "runs", header: "运行", width: "5rem", numeric: true },
        { key: "files", header: "文件", width: "5rem", numeric: true },
    ];
    return (
        <Card>
            <CardHeader className="flex flex-row items-center gap-2">
                <CardTitle>规则统计 ({stats.total} 次命中)</CardTitle>
                <span className="ml-auto text-[length:var(--fs-2xs)] text-muted-foreground">
                    全部仓库, 按命中次数排序
                </span>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
                <p className="text-[length:var(--fs-xs)] text-muted-foreground">
                    {stats.topRule ? `触发最多: ${stats.topRule}。` : "暂无规则命中。"} 已豁免 {stats.waived} 条。
                    {stats.repo ? ` 仓库: ${stats.repo}。` : " 覆盖全部仓库。"}
                </p>
                <p className="flex flex-wrap gap-1.5">
                    {stats.bySeverity.map((item) => (
                        <Badge key={item.severity} variant={item.severity === "error" ? "destructive" : "warning"}>
                            {item.severity === "error" ? "错误" : "告警"} {item.total} 条, 涉及 {item.rules} 条规则
                        </Badge>
                    ))}
                    {filter !== "all" ? <Badge variant="secondary">{kindLabel(filter)}</Badge> : null}
                </p>
            </CardContent>
            <CardContent className="px-0 pb-0">
                <DataTable
                    bare
                    maxHeight="34rem"
                    rowKey={(row) => row.ruleId}
                    rows={rows}
                    columns={columns}
                    emptyText={filter === "all" ? "暂无规则命中" : `暂无${kindLabel(filter)}规则命中`}
                />
            </CardContent>
        </Card>
    );
}
