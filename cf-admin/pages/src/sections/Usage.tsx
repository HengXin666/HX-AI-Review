import { useEffect, useState } from "react";
import {
    Badge,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DataTable,
    EmptyState,
    SegmentedControl,
    StatCard,
    StatGrid,
} from "@hx/ui";
import type { DataTableColumn } from "@hx/ui";
import { api, kindOf } from "../api.ts";
import type { UsageBucket, UsageGroup, UsageStats, UsageSummary } from "../api.ts";
import { usd } from "../format.ts";
import { kindLabel } from "../kind.ts";
import { statusLabel, statusVariant } from "../status.ts";

// Token usage. Every model the system runs is free, so cost is always about 0: tokens are the headline and
// dollars only appear as a muted column. A zero next to a run count is always explained by its failures.

/** Token counts with a unit: 950, 12.3k, 1.25M. Never a bare seven-digit number. */
export function compactTokens(value: number): string {
    if (!Number.isFinite(value)) {
        return "0";
    }
    const abs = Math.abs(value);
    if (abs >= 1_000_000) {
        return (value / 1_000_000).toFixed(2) + "M";
    }
    if (abs >= 1000) {
        return (value / 1000).toFixed(1) + "k";
    }
    return String(Math.round(value));
}

/** Signed percentage against the previous month; null when last month had no tokens to compare with. */
function changeText(pct: number | null): string {
    if (pct === null) {
        return "上月无消耗, 无法对比";
    }
    return "较上月 " + (pct > 0 ? "+" : "") + pct.toFixed(1) + "%";
}

type Span = "7" | "30" | "90" | "all";

const WINDOWS: { key: Span; label: string }[] = [
    { key: "7", label: "最近 7 天" },
    { key: "30", label: "30 天" },
    { key: "90", label: "90 天" },
    { key: "all", label: "全部" },
];

const GROUPS: { key: UsageGroup; label: string }[] = [
    { key: "day", label: "日" },
    { key: "repo", label: "仓库" },
    { key: "provider", label: "provider" },
    { key: "kind", label: "kind" },
    { key: "status", label: "status" },
];

/** First UTC day of a span ending today; "all" starts before any run could exist. */
function fromOf(span: Span): string {
    if (span === "all") {
        return "1970-01-01";
    }
    const days = Number(span);
    return new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** Why a bucket shows the tokens it shows: a run count with zero tokens must never look like "free". */
function explain(row: UsageBucket): { text: string; tone: "bad" | "warn" | "muted" } {
    const tokens = row.inputTokens + row.outputTokens;
    const broken = row.failedRuns + row.incompleteRuns;
    if (row.runs > 0 && tokens === 0) {
        if (broken > 0) {
            return { text: `0 token: ${row.failedRuns} 失败 / ${row.incompleteRuns} 未完成`, tone: "bad" };
        }
        return { text: "0 token: 只跑了 L0 或无变更", tone: "muted" };
    }
    if (row.zeroTokenRuns > 0) {
        return { text: `其中 ${row.zeroTokenRuns} 次 0 token`, tone: broken > 0 ? "warn" : "muted" };
    }
    return { text: "", tone: "muted" };
}

const TONE_CLASS = { bad: "text-danger-fg", warn: "text-warning-fg", muted: "text-muted-foreground" } as const;

function keyCell(group: UsageGroup, key: string) {
    if (group === "kind") {
        return <Badge variant="secondary">{kindLabel(kindOf(key))}</Badge>;
    }
    if (group === "status") {
        return <Badge variant={statusVariant(key)}>{statusLabel(key)}</Badge>;
    }
    return <span className="font-mono text-[length:var(--fs-xs)]">{key || "-"}</span>;
}

/** A plain proportional bar: no chart library, one div whose width is the share of the largest bucket. */
function Bar({ value, max }: { value: number; max: number }) {
    const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0;
    return (
        <div className="flex items-center gap-2">
            <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary" style={{ width: pct + "%" }} />
            </div>
            <span className="tabular-nums">{compactTokens(value)}</span>
        </div>
    );
}

function columns(group: UsageGroup, max: number): DataTableColumn<UsageBucket>[] {
    return [
        {
            key: "key",
            header: GROUPS.find((item) => item.key === group)?.label ?? group,
            width: "12rem",
            render: (row) => keyCell(group, row.key),
        },
        { key: "runs", header: "运行", width: "5rem", numeric: true, render: (row) => row.runs },
        {
            key: "total",
            header: "总 token",
            width: "11rem",
            render: (row) => <Bar value={row.inputTokens + row.outputTokens} max={max} />,
        },
        {
            key: "input",
            header: "input",
            width: "6rem",
            numeric: true,
            render: (row) => compactTokens(row.inputTokens),
        },
        {
            key: "output",
            header: "output",
            width: "6rem",
            numeric: true,
            render: (row) => compactTokens(row.outputTokens),
        },
        {
            key: "broken",
            header: "失败 / 未完成",
            width: "7rem",
            numeric: true,
            render: (row) => (
                <span>
                    <span className={row.failedRuns > 0 ? "text-danger-fg" : "text-muted-foreground"}>
                        {row.failedRuns}
                    </span>
                    <span className="text-muted-foreground"> / </span>
                    <span className={row.incompleteRuns > 0 ? "text-warning-fg" : "text-muted-foreground"}>
                        {row.incompleteRuns}
                    </span>
                </span>
            ),
        },
        {
            key: "why",
            header: "说明",
            width: "14rem",
            render: (row) => {
                const note = explain(row);
                return <span className={"text-[length:var(--fs-2xs)] " + TONE_CLASS[note.tone]}>{note.text}</span>;
            },
        },
        {
            key: "cost",
            header: "美元",
            width: "5rem",
            numeric: true,
            render: (row) => <span className="text-muted-foreground">{usd(row.costUsd, 3)}</span>,
        },
    ];
}

/** Seven thin columns for the last seven days; a day that ran but used no tokens gets a red stub. */
export function MiniTrend({ days }: { days: UsageSummary["last7Days"] }) {
    const max = Math.max(0, ...days.map((day) => day.totalTokens));
    return (
        <div className="flex h-8 items-end gap-0.5" aria-label="最近 7 天 token">
            {days.map((day) => {
                const broken = day.runs > 0 && day.totalTokens === 0;
                const pct = max > 0 ? Math.max(day.totalTokens > 0 ? 6 : 0, (day.totalTokens / max) * 100) : 0;
                return (
                    <div
                        key={day.day}
                        title={`${day.day}: ${compactTokens(day.totalTokens)} token, ${day.runs} 次运行${
                            broken ? `, ${day.failedRuns} 失败 / ${day.incompleteRuns} 未完成` : ""
                        }`}
                        className={"w-2 rounded-sm " + (broken ? "bg-danger" : "bg-primary")}
                        style={{ height: broken ? "12%" : pct + "%" }}
                    />
                );
            })}
        </div>
    );
}

/** The overview strip: this month's tokens and the 7-day trend, one click away from #/usage. */
export function UsageStrip({ onOpen }: { onOpen: () => void }) {
    const [summary, setSummary] = useState<UsageSummary | null>(null);
    useEffect(() => {
        api.usageSummary().then(setSummary, () => setSummary(null));
    }, []);
    if (!summary) {
        return null;
    }
    const current = summary.current;
    return (
        <button
            type="button"
            onClick={onOpen}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border/50 bg-card/40 px-3 py-2 text-left transition-colors hover:border-border hover:bg-muted/40"
        >
            <div className="flex flex-col">
                <span className="text-[length:var(--fs-2xs)] text-muted-foreground">{summary.month} token 总量</span>
                <span className="text-[length:var(--fs-lg)] font-semibold tabular-nums">
                    {compactTokens(current.totalTokens)}
                </span>
            </div>
            <span className="tabular-nums text-[length:var(--fs-2xs)] text-muted-foreground">
                input {compactTokens(current.inputTokens)} · output {compactTokens(current.outputTokens)} ·{" "}
                {changeText(summary.tokenChangePct)}
            </span>
            {current.failedRuns + current.incompleteRuns > 0 ? (
                <Badge variant="warning">
                    {current.failedRuns} 失败 / {current.incompleteRuns} 未完成
                </Badge>
            ) : null}
            <div className="ml-auto">
                <MiniTrend days={summary.last7Days} />
            </div>
        </button>
    );
}

/** #/usage: four monthly cards, then one table over a chosen span and dimension. */
export function Usage() {
    const [summary, setSummary] = useState<UsageSummary | null>(null);
    const [stats, setStats] = useState<UsageStats | null>(null);
    const [span, setSpan] = useState<Span>("30");
    const [group, setGroup] = useState<UsageGroup>("day");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        api.usageSummary().then(setSummary, (err: Error) => setError(err.message));
    }, []);

    // Every change of span or dimension is a fresh request: the server does the aggregation.
    useEffect(() => {
        let live = true;
        setLoading(true);
        api.usage({ from: fromOf(span), group }).then(
            (next) => {
                if (live) {
                    setStats(next);
                    setError(null);
                    setLoading(false);
                }
            },
            (err: Error) => {
                if (live) {
                    setError(err.message);
                    setLoading(false);
                }
            },
        );
        return () => {
            live = false;
        };
    }, [span, group]);

    const current = summary?.current;
    const broken = current ? current.failedRuns + current.incompleteRuns : 0;
    const failRate = current && current.runs > 0 ? (broken / current.runs) * 100 : 0;
    const buckets = stats?.buckets ?? [];
    const max = Math.max(0, ...buckets.map((row) => row.inputTokens + row.outputTokens));
    const totals = stats?.totals;

    return (
        <>
            <StatGrid columns={4}>
                <StatCard
                    label={`${summary?.month ?? "本月"} input token`}
                    value={current ? compactTokens(current.inputTokens) : "-"}
                    tone="accent"
                    hint={summary ? changeText(summary.tokenChangePct) : undefined}
                />
                <StatCard
                    label={`${summary?.month ?? "本月"} output token`}
                    value={current ? compactTokens(current.outputTokens) : "-"}
                    hint={current ? `合计 ${compactTokens(current.totalTokens)}` : undefined}
                />
                <StatCard
                    label="本月运行数"
                    value={current ? current.runs : "-"}
                    hint={summary ? `${summary.activeRepos} 个活跃仓库` : undefined}
                />
                <StatCard
                    label="失败率"
                    value={current ? failRate.toFixed(1) + "%" : "-"}
                    tone={broken > 0 ? "bad" : "good"}
                    hint={current ? `${current.failedRuns} 失败 / ${current.incompleteRuns} 未完成` : undefined}
                />
            </StatGrid>

            <Card>
                <CardHeader className="flex flex-row flex-wrap items-center gap-2">
                    <CardTitle>聚合</CardTitle>
                    <div role="group" aria-label="时间窗">
                        <SegmentedControl items={WINDOWS} value={span} onChange={setSpan} />
                    </div>
                    <div role="group" aria-label="维度">
                        <SegmentedControl items={GROUPS} value={group} onChange={setGroup} />
                    </div>
                    {totals ? (
                        <span className="ml-auto tabular-nums text-[length:var(--fs-2xs)] text-muted-foreground">
                            {stats?.from} 至 {stats?.to}: {totals.runs} 次运行, {compactTokens(totals.inputTokens)}{" "}
                            input / {compactTokens(totals.outputTokens)} output, {totals.failedRuns} 失败 /{" "}
                            {totals.incompleteRuns} 未完成
                        </span>
                    ) : null}
                </CardHeader>
                <CardContent className="px-0 pb-0">
                    {error ? (
                        <EmptyState compact kind="error" text="加载失败" hint={error} />
                    ) : (
                        <DataTable
                            bare
                            loading={loading && !stats}
                            maxHeight="34rem"
                            rowKey={(row) => row.key}
                            rows={buckets}
                            columns={columns(group, max)}
                            emptyText="这个时间窗内没有运行"
                        />
                    )}
                </CardContent>
            </Card>
            <p className="text-[length:var(--fs-2xs)] text-muted-foreground">
                日按 UTC 切分。失败 = L0 阻断错误; 未完成 = 模型阶段没跑完 (例如 provider 返回 402), 这类运行 token 为
                0。provider 维度取仓库当前配置的 provider。美元列只作参考, 免费模型恒为 0。
            </p>
        </>
    );
}
