import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, StatCard, StatGrid } from "@hx/ui";
import type { Overview as OverviewData } from "../api.ts";
import { kindOf } from "../api.ts";
import { dateTime, duration, shortSha, usd } from "../format.ts";
import { kindLabel, kindVariant, totals } from "../kind.ts";
import type { KindFilter } from "../kind.ts";
import { severityLabel, severityVariant, statusLabel, statusVariant } from "../status.ts";
import type { SectionId } from "../shell.tsx";

type Props = {
    data: OverviewData;
    filter: KindFilter;
    onSection: (id: SectionId) => void;
    onVerdict: (id: string, verdict: "accepted" | "rejected", reason: string) => void;
};

/**
 * Dashboard: headline numbers, the two kinds side by side, and the shortest path to the detail screens.
 *
 * The kind filter lives here rather than in each card so every number on the screen answers the same
 * question. Code CR and context CR differ in what they produce (patches vs suggestions), so the two
 * columns also state their own rule namespace.
 */
export function Overview({ data, filter, onSection, onVerdict }: Props) {
    const sums = totals(data, filter);
    const findings = data.findings.filter((row) => filter === "all" || kindOf(row.kind) === filter);
    const runs = data.runs.filter((row) => filter === "all" || kindOf(row.kind) === filter);
    const spendTone = sums.budgetUsd > 0 && sums.spendUsd >= sums.budgetUsd ? "bad" : "default";

    return (
        <>
            <StatGrid columns={5}>
                <StatCard
                    label="错误"
                    value={sums.errors}
                    tone={sums.errors > 0 ? "bad" : "good"}
                    hint="只来自 L0 确定性检查"
                />
                <StatCard
                    label="告警"
                    value={sums.warnings}
                    tone={sums.warnings > 0 ? "default" : "muted"}
                    hint="AI 阶段产出"
                />
                <StatCard
                    label="待处理发现"
                    value={sums.open}
                    tone={sums.open > 0 ? "accent" : "muted"}
                    hint={filter === "all" ? "全部 CR 类型" : kindLabel(filter)}
                />
                <StatCard
                    label={`${data.month} 花费`}
                    value={usd(sums.spendUsd)}
                    tone={spendTone}
                    hint={sums.budgetUsd > 0 ? `预算 ${usd(sums.budgetUsd)} / ${sums.repos} 个仓库` : "未设月度上限"}
                />
                <StatCard
                    label="运行数"
                    value={sums.runs}
                    hint={`上下文 ${sums.contextRuns} / 代码 ${sums.codeRuns}`}
                />
            </StatGrid>

            <div className="grid gap-3 lg:grid-cols-2">
                <Card>
                    <CardHeader className="flex flex-row items-center gap-2">
                        <CardTitle>待处理发现</CardTitle>
                        <Badge variant="secondary">{findings.length}</Badge>
                        <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="ml-auto"
                            onClick={() => onSection("findings")}
                        >
                            全部
                        </Button>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-1.5">
                        {findings.length === 0 ? (
                            <EmptyState compact text="暂无待处理发现" hint="新的运行产出发现后会出现在这里。" />
                        ) : (
                            findings.slice(0, 6).map((row) => (
                                <div
                                    key={row.id}
                                    className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/40 px-2 py-1.5"
                                >
                                    <Badge variant={kindVariant(kindOf(row.kind))}>{kindLabel(kindOf(row.kind))}</Badge>
                                    <Badge variant={severityVariant(row.severity)}>{severityLabel(row.severity)}</Badge>
                                    <span className="font-mono text-[length:var(--fs-2xs)] text-muted-foreground">
                                        {row.ruleId}
                                    </span>
                                    <span
                                        className="min-w-0 flex-1 truncate text-[length:var(--fs-xs)]"
                                        title={row.message}
                                    >
                                        {row.message}
                                    </span>
                                    <span className="font-mono text-[length:var(--fs-3xs)] text-muted-foreground">
                                        {row.path}:{row.line}
                                    </span>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="xs"
                                        onClick={() => onVerdict(row.id, "accepted", "")}
                                    >
                                        接受
                                    </Button>
                                </div>
                            ))
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center gap-2">
                        <CardTitle>最近运行</CardTitle>
                        <Badge variant="secondary">{runs.length}</Badge>
                        <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="ml-auto"
                            onClick={() => onSection("runs")}
                        >
                            全部
                        </Button>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-1.5">
                        {runs.length === 0 ? (
                            <EmptyState compact text="暂无运行记录" hint="runner 上报后会出现在这里。" />
                        ) : (
                            runs.slice(0, 6).map((row) => (
                                <div
                                    key={row.id}
                                    className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/40 px-2 py-1.5"
                                >
                                    <Badge variant={kindVariant(kindOf(row.kind))}>{kindLabel(kindOf(row.kind))}</Badge>
                                    <Badge variant={statusVariant(row.status)}>{statusLabel(row.status)}</Badge>
                                    <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-xs)]">
                                        {row.repo} {shortSha(row.sha)}
                                    </span>
                                    <span className="tabular-nums text-[length:var(--fs-2xs)] text-muted-foreground">
                                        {row.errors}E / {row.warnings}W
                                    </span>
                                    <span className="tabular-nums text-[length:var(--fs-2xs)] text-muted-foreground">
                                        {usd(row.costUsd, 3)}
                                    </span>
                                    <span className="tabular-nums text-[length:var(--fs-3xs)] text-muted-foreground">
                                        {duration(row.durationMs)} · {dateTime(row.createdAt)}
                                    </span>
                                </div>
                            ))
                        )}
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader className="flex flex-row items-center gap-2">
                    <CardTitle>两种 CR 的分工</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-[length:var(--fs-xs)] sm:grid-cols-2">
                    <div className="flex flex-col gap-1 rounded-lg border border-border/40 p-2">
                        <Badge variant="secondary" className="w-fit">
                            上下文 CR
                        </Badge>
                        <span className="text-muted-foreground">
                            审 AGENTS.md / README.md / docs 是否与代码一致。规则 HC-*, CX-*。可以产出上下文文件的补丁。
                        </span>
                    </div>
                    <div className="flex flex-col gap-1 rounded-lg border border-border/40 p-2">
                        <Badge className="w-fit">代码 CR</Badge>
                        <span className="text-muted-foreground">
                            审 diff 新增与修改的行: 逻辑错误, 边界条件, 错误处理, 并发与资源, 安全边界。规则 CODE-*,
                            只给建议, 不推补丁。
                        </span>
                    </div>
                </CardContent>
            </Card>
        </>
    );
}
