import { useEffect, useState } from "react";
import { Badge, Card, CardContent, CardHeader, CardTitle, DataTable, EmptyState } from "@hx/ui";
import type { DataTableColumn } from "@hx/ui";
import { api } from "../api.ts";
import type { CatalogRule } from "../api.ts";

/** The three rule sets, in the order a change meets them: CI gate, local diff check, local test suite. */
const GROUPS: { source: CatalogRule["source"]; title: string; hint: string }[] = [
    { source: "ci", title: "CI 门禁", hint: "runner 在 GitHub Actions 里跑的 L0 确定性规则" },
    { source: "local", title: "本地 diff", hint: "本地 diff 检查额外报告的规则, 与 CI 共用 id 命名空间" },
    { source: "test", title: "本地测试", hint: "本地测试编排的六类测试, 任一失败即判定命中" },
];

function severityBadge(severity: CatalogRule["severity"]) {
    if (severity === "none") {
        return <Badge variant="secondary">未启用</Badge>;
    }
    return (
        <Badge variant={severity === "error" ? "destructive" : "warning"}>
            {severity === "error" ? "错误" : "告警"}
        </Badge>
    );
}

type State = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; rules: CatalogRule[] };

/**
 * Every rule definition with its criteria, whether or not it ever fired. This is the rule set itself; the
 * "rules" screen (Rules.tsx) is hit statistics over recorded results and only lists rules that matched.
 */
export function RuleCatalog() {
    const [state, setState] = useState<State>({ phase: "loading" });

    useEffect(() => {
        let live = true;
        api.rulesCatalog().then(
            (rules) => {
                if (live) {
                    setState({ phase: "ready", rules });
                }
            },
            (error: Error) => {
                if (live) {
                    setState({ phase: "error", message: error.message });
                }
            },
        );
        return () => {
            live = false;
        };
    }, []);

    const columns: DataTableColumn<CatalogRule>[] = [
        {
            key: "id",
            header: "ID",
            width: "9rem",
            render: (row) => <span className="font-mono text-[length:var(--fs-xs)]">{row.id}</span>,
        },
        {
            key: "severity",
            header: "等级",
            width: "6rem",
            render: (row) => severityBadge(row.severity),
        },
        { key: "description", header: "描述", width: "18rem" },
        {
            key: "criteria",
            header: "判据",
            render: (row) => <span className="text-[length:var(--fs-xs)] text-muted-foreground">{row.criteria}</span>,
        },
    ];

    if (state.phase !== "ready") {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>规则一览</CardTitle>
                </CardHeader>
                <CardContent>
                    {state.phase === "loading" ? (
                        <EmptyState compact kind="loading" text="加载中..." />
                    ) : (
                        <EmptyState compact kind="error" text="规则清单暂不可用" hint={state.message} />
                    )}
                </CardContent>
            </Card>
        );
    }

    // One table per rule set, so which rules a change is bound to reads at a glance.
    return (
        <>
            {GROUPS.map((group) => {
                const rows = state.rules.filter((rule) => rule.source === group.source);
                return (
                    <Card key={group.source}>
                        <CardHeader className="flex flex-row items-center gap-2">
                            <CardTitle>
                                {group.title} ({rows.length} 条)
                            </CardTitle>
                            <span className="ml-auto text-[length:var(--fs-2xs)] text-muted-foreground">
                                {group.hint}
                            </span>
                        </CardHeader>
                        <CardContent className="px-0 pb-0">
                            <DataTable
                                bare
                                rowKey={(row) => row.id}
                                rows={rows}
                                columns={columns}
                                emptyText="这一组没有规则"
                            />
                        </CardContent>
                    </Card>
                );
            })}
        </>
    );
}
