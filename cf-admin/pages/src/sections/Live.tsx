import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
    Alert,
    AlertDescription,
    AlertTitle,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DataTable,
    EmptyState,
    MotionSelect,
} from "@hx/ui";
import type { DataTableColumn } from "@hx/ui";
import type { Kind } from "../api.ts";
import { dateTime, duration } from "../format.ts";
import { kindLabel, kindVariant } from "../kind.ts";
import { connectLive, LIVE_STAGES } from "../live.ts";
import type {
    DonePayload,
    FindingPayload,
    LiveEvent,
    LiveStage,
    LiveStatus,
    LogLevel,
    ProgressPayload,
    SnapshotFrame,
    StageStatus,
} from "../live.ts";
import { severityLabel, severityVariant } from "../status.ts";

/** Labels for the six cells of the stage bar. The keys are contract stage names and stay in English. */
const STAGE_LABELS: Record<LiveStage, string> = {
    init: "init 初始化",
    l0: "l0 确定性检查",
    rules: "rules 规则",
    scope: "scope 范围",
    review: "review 评审",
    publish: "publish 发布",
};

/** Logs kept per run. Older lines are dropped so a long run cannot grow the page without bound. */
const LOG_CAP = 2000;

type LogRow = { seq: number; at: string; stage: string; level: LogLevel; message: string };
type FindingRow = { seq: number } & FindingPayload;

type RunState = {
    runId: string;
    repo: string;
    kind: Kind;
    startedAt: string;
    lastAt: string;
    stages: Partial<Record<string, { status: StageStatus; durationMs?: number; message?: string }>>;
    progress: ProgressPayload | null;
    logs: LogRow[];
    findings: FindingRow[];
    done: DonePayload | null;
};

/** The last event seen per repo: the global activity list is drawn from this cache, not from extra sockets. */
type RepoSeen = { repo: string; at: string; type: string; runId: string; kind: Kind };

type State = { runs: Record<string, RunState>; seen: Record<string, RepoSeen>; seq: number };

type Action = { type: "event"; event: LiveEvent } | { type: "snapshot"; frame: SnapshotFrame };

/** GitHub names are case-insensitive; the server keys rooms by the lower-cased name and so does this cache. */
function repoKey(repo: string): string {
    return repo.toLowerCase();
}

function runKey(repo: string, runId: string): string {
    return repoKey(repo) + "\n" + runId;
}

function emptyRun(event: LiveEvent): RunState {
    return {
        runId: event.runId,
        repo: event.repo,
        kind: event.kind,
        startedAt: event.at,
        lastAt: event.at,
        stages: {},
        progress: null,
        logs: [],
        findings: [],
        done: null,
    };
}

/** Fold one event into the run it belongs to. Events are the only source: nothing here is invented. */
function applyEvent(state: State, event: LiveEvent): State {
    const seq = state.seq + 1;
    const key = runKey(event.repo, event.runId);
    const prev = state.runs[key] ?? emptyRun(event);
    const run: RunState = { ...prev, lastAt: event.at > prev.lastAt ? event.at : prev.lastAt };
    switch (event.type) {
        case "stage":
            run.stages = {
                ...prev.stages,
                [event.payload.stage]: {
                    status: event.payload.status,
                    durationMs: event.payload.durationMs,
                    message: event.payload.message,
                },
            };
            break;
        case "log": {
            const row: LogRow = { seq, at: event.at, ...event.payload };
            const logs = prev.logs.length >= LOG_CAP ? prev.logs.slice(prev.logs.length - LOG_CAP + 1) : prev.logs;
            run.logs = [...logs, row];
            break;
        }
        case "finding":
            run.findings = [...prev.findings, { seq, ...event.payload }];
            break;
        case "progress":
            run.progress = event.payload;
            break;
        case "done":
            run.done = event.payload;
            break;
    }
    const seen: RepoSeen = { repo: event.repo, at: event.at, type: event.type, runId: event.runId, kind: event.kind };
    return {
        seq,
        runs: { ...state.runs, [key]: run },
        seen: { ...state.seen, [repoKey(event.repo)]: seen },
    };
}

/**
 * Rebuild one repo's active list from a snapshot. On a gap every cached run of the repo is dropped first, since
 * events between the resume point and now are gone. Unfinished runs the snapshot no longer lists ended while we
 * were not looking and are dropped too; finished runs are kept so their logs stay readable.
 */
function applySnapshot(state: State, frame: SnapshotFrame): State {
    const room = repoKey(frame.repo);
    const listed = new Set(frame.payload.runs.map((run) => run.runId));
    const runs: Record<string, RunState> = {};
    for (const [key, run] of Object.entries(state.runs)) {
        if (repoKey(run.repo) !== room) {
            runs[key] = run;
        } else if (!frame.payload.gap && (run.done || listed.has(run.runId))) {
            runs[key] = run;
        }
    }
    let newest: RepoSeen | null = null;
    for (const active of frame.payload.runs) {
        const key = runKey(frame.repo, active.runId);
        const prev: RunState = runs[key] ?? {
            runId: active.runId,
            repo: frame.repo,
            kind: active.kind,
            startedAt: active.startedAt,
            lastAt: active.updatedAt,
            stages: {},
            progress: null,
            logs: [],
            findings: [],
            done: null,
        };
        const run: RunState = { ...prev, lastAt: active.updatedAt > prev.lastAt ? active.updatedAt : prev.lastAt };
        if (active.stage && active.status && !prev.stages[active.stage]) {
            run.stages = { ...prev.stages, [active.stage]: { status: active.status } };
        }
        runs[key] = run;
        if (!newest || active.updatedAt > newest.at) {
            newest = {
                repo: frame.repo,
                at: active.updatedAt,
                type: "snapshot",
                runId: active.runId,
                kind: active.kind,
            };
        }
    }
    const seen = { ...state.seen };
    if (newest && (!seen[room] || newest.at > seen[room].at)) {
        seen[room] = newest;
    }
    return { seq: state.seq + 1, runs, seen };
}

function reduce(state: State, action: Action): State {
    return action.type === "event" ? applyEvent(state, action.event) : applySnapshot(state, action.frame);
}

function isRunning(run: RunState): boolean {
    if (run.done) {
        return false;
    }
    return !Object.values(run.stages).some((stage) => stage?.status === "failed");
}

/** Newest first: the run that moved last is the one the user most likely wants. */
function byRecent(a: RunState, b: RunState): number {
    return a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0;
}

function stageClass(status: StageStatus | undefined): string {
    if (status === "running") {
        return "border-primary bg-primary/20 text-heading animate-pulse";
    }
    if (status === "done") {
        return "border-success/40 bg-success/10 text-success-fg";
    }
    if (status === "failed") {
        return "border-danger bg-danger/20 text-danger-fg";
    }
    return "border-border/50 bg-card/40 text-muted-foreground";
}

const STATUS_TEXT: Record<StageStatus, string> = { running: "运行中", done: "完成", failed: "失败" };

function levelClass(level: LogLevel): string {
    if (level === "error") {
        return "text-danger-fg";
    }
    return level === "warn" ? "text-warning-fg" : "text-muted-foreground";
}

/** Only the parts the runner actually sent: finder batches, candidates, verifier progress. */
function progressText(progress: ProgressPayload): string {
    const parts: string[] = [];
    if (progress.finder) {
        const of = progress.finder.batches !== undefined ? "/" + progress.finder.batches : "";
        parts.push(`批次 ${progress.finder.batch}${of}`);
    }
    if (progress.candidates !== undefined) {
        parts.push(`候选 ${progress.candidates}`);
    }
    if (progress.verifier) {
        const of = progress.verifier.total !== undefined ? "/" + progress.verifier.total : "";
        parts.push(`已复核 ${progress.verifier.done}${of}`);
    }
    return parts.join(", ");
}

/** The six-cell stage bar: running is highlighted, failed is red, untouched stages stay grey. */
function StageBar({ run }: { run: RunState }) {
    return (
        <div className="grid grid-cols-3 gap-1.5 md:grid-cols-6" role="list" aria-label="阶段进度">
            {LIVE_STAGES.map((stage) => {
                const state = run.stages[stage];
                const progress = run.progress && run.progress.stage === stage ? run.progress : null;
                return (
                    <div
                        key={stage}
                        role="listitem"
                        className={"flex flex-col gap-0.5 rounded-lg border px-2 py-1.5 " + stageClass(state?.status)}
                    >
                        <span className="text-[length:var(--fs-xs)] font-medium">{STAGE_LABELS[stage]}</span>
                        <span className="text-[length:var(--fs-2xs)] tabular-nums">
                            {state ? STATUS_TEXT[state.status] : "未开始"}
                            {state && state.status !== "running" && state.durationMs !== undefined
                                ? ", " + duration(state.durationMs)
                                : ""}
                        </span>
                        {progress ? (
                            <span className="text-[length:var(--fs-2xs)] tabular-nums">{progressText(progress)}</span>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

function LogPanel({ run }: { run: RunState }) {
    const [paused, setPaused] = useState(false);
    const [stage, setStage] = useState("all");
    const box = useRef<HTMLDivElement | null>(null);
    const rows = stage === "all" ? run.logs : run.logs.filter((row) => row.stage === stage);
    const options = useMemo(() => {
        const seen = new Set<string>(LIVE_STAGES);
        for (const row of run.logs) {
            seen.add(row.stage);
        }
        return [{ value: "all", label: "全部阶段" }, ...[...seen].map((value) => ({ value, label: value }))];
    }, [run.logs]);
    const last = rows.length > 0 ? rows[rows.length - 1].seq : 0;

    useEffect(() => {
        if (!paused && box.current) {
            box.current.scrollTop = box.current.scrollHeight;
        }
    }, [last, paused]);

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-center gap-2">
                <CardTitle>日志 ({rows.length})</CardTitle>
                <div className="ml-auto flex items-center gap-2">
                    <MotionSelect
                        aria-label="按阶段过滤日志"
                        value={stage}
                        onValueChange={setStage}
                        options={options}
                        triggerClassName="h-8 w-40 text-[length:var(--fs-xs)]"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => setPaused((value) => !value)}>
                        {paused ? "恢复滚动" : "暂停滚动"}
                    </Button>
                </div>
            </CardHeader>
            <CardContent>
                <div
                    ref={box}
                    className="h-80 overflow-y-auto rounded-lg border border-border/50 bg-background/60 p-2 font-mono text-[length:var(--fs-2xs)]"
                >
                    {rows.length === 0 ? (
                        <p className="text-muted-foreground">
                            {run.logs.length === 0 ? "本次运行还没有日志" : "该阶段没有日志"}
                        </p>
                    ) : (
                        rows.map((row) => (
                            <div key={row.seq} className={"whitespace-pre-wrap break-all " + levelClass(row.level)}>
                                <span className="text-muted-foreground">{dateTime(row.at)} </span>
                                <span className="text-muted-foreground">[{row.stage}] </span>
                                {row.message}
                            </div>
                        ))
                    )}
                </div>
                {paused ? (
                    <p className="mt-1 text-[length:var(--fs-2xs)] text-muted-foreground">
                        已暂停自动滚动, 新日志仍在接收
                    </p>
                ) : null}
            </CardContent>
        </Card>
    );
}

const FINDING_COLUMNS: DataTableColumn<FindingRow>[] = [
    {
        key: "severity",
        header: "等级",
        width: "6rem",
        render: (row) =>
            row.severity ? <Badge variant={severityVariant(row.severity)}>{severityLabel(row.severity)}</Badge> : "-",
    },
    { key: "ruleId", header: "规则", width: "9rem" },
    {
        key: "path",
        header: "位置",
        width: "16rem",
        render: (row) => (
            <span className="font-mono text-[length:var(--fs-2xs)]">
                {row.line !== undefined ? `${row.path}:${row.line}` : row.path}
            </span>
        ),
    },
    { key: "message", header: "说明", render: (row) => row.message ?? "-" },
];

function statusAlert(status: LiveStatus, attempt: number) {
    if (status === "unavailable") {
        return (
            <Alert variant="warning">
                <AlertTitle>后端未就绪</AlertTitle>
                <AlertDescription>
                    实时通道 /api/live 多次握手失败, 后端可能尚未部署该接口.正在自动重试 (第 {attempt} 次).
                </AlertDescription>
            </Alert>
        );
    }
    if (status === "reconnecting") {
        return (
            <Alert variant="warning">
                <AlertTitle>实时连接已断开</AlertTitle>
                <AlertDescription>正在重连 (第 {attempt} 次), 恢复后会从断点续传, 不会丢失事件.</AlertDescription>
            </Alert>
        );
    }
    if (status === "connecting") {
        return <p className="text-[length:var(--fs-2xs)] text-muted-foreground">正在连接实时通道...</p>;
    }
    return null;
}

type Props = { repos: string[] };

/**
 * Live view. The server allows one repo per socket, so exactly one socket is open: the repo picked in the
 * selector. Switching closes the old socket and opens a new one. Runs and the last event of every repo seen
 * so far stay cached, so the activity list still covers repos visited earlier without keeping their sockets.
 */
export function Live({ repos }: Props) {
    const [state, dispatch] = useReducer(reduce, { runs: {}, seen: {}, seq: 0 });
    const [conn, setConn] = useState<{ status: LiveStatus; attempt: number }>({ status: "connecting", attempt: 0 });
    const [picked, setPicked] = useState<string | null>(null);
    const subscribed = picked && repos.includes(picked) ? picked : (repos[0] ?? null);

    useEffect(() => {
        if (!subscribed) {
            return;
        }
        return connectLive(subscribed, {
            onEvent: (event) => dispatch({ type: "event", event }),
            onSnapshot: (frame) => dispatch({ type: "snapshot", frame }),
            onStatus: (status, attempt) => setConn({ status, attempt }),
        });
    }, [subscribed]);

    const repoOptions = useMemo(() => repos.map((repo) => ({ value: repo, label: repo })), [repos]);
    const runs = Object.values(state.runs).sort(byRecent);
    const seen = Object.values(state.seen).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const running = runs.filter(isRunning);
    const runsOfRepo = subscribed ? runs.filter((run) => repoKey(run.repo) === repoKey(subscribed)) : [];
    const current = runsOfRepo.find(isRunning) ?? runsOfRepo[0] ?? null;

    if (repos.length === 0) {
        return <EmptyState text="还没有登记仓库" hint="在 仓库 页登记仓库后, 它的运行会实时出现在这里." />;
    }

    return (
        <div className="flex flex-col gap-3">
            {statusAlert(conn.status, conn.attempt)}
            <Card>
                <CardHeader className="flex flex-row flex-wrap items-center gap-2">
                    <CardTitle>正在运行 ({running.length})</CardTitle>
                    <Badge variant={conn.status === "open" ? "success" : "secondary"}>
                        {conn.status === "open" ? "已连接" : "未连接"}
                    </Badge>
                    <div className="ml-auto flex items-center gap-2">
                        <span className="text-[length:var(--fs-2xs)] text-muted-foreground">订阅仓库</span>
                        <MotionSelect
                            aria-label="选择要订阅的仓库"
                            value={subscribed ?? ""}
                            onValueChange={setPicked}
                            options={repoOptions}
                            triggerClassName="h-8 w-64 font-mono text-[length:var(--fs-xs)]"
                        />
                    </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                    <p className="text-[length:var(--fs-2xs)] text-muted-foreground">
                        同一时间只订阅一个仓库; 下方列表是各仓库最近一次收到的事件缓存, 点击可切换订阅.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {seen.length === 0 ? (
                            <p className="text-[length:var(--fs-xs)] text-muted-foreground">
                                {conn.status === "open"
                                    ? "当前没有正在运行的检查, 有运行开始后会实时出现在这里."
                                    : "尚未收到任何事件."}
                            </p>
                        ) : (
                            seen.map((item) => {
                                const ofRepo = runs.filter((run) => repoKey(run.repo) === repoKey(item.repo));
                                const live = ofRepo.filter(isRunning);
                                const kinds = [
                                    ...new Set((live.length > 0 ? live : ofRepo.slice(0, 1)).map((run) => run.kind)),
                                ];
                                const isSubscribed = subscribed !== null && repoKey(item.repo) === repoKey(subscribed);
                                const target = repos.find((repo) => repoKey(repo) === repoKey(item.repo));
                                return (
                                    <Button
                                        key={repoKey(item.repo)}
                                        type="button"
                                        variant={isSubscribed ? "primary" : "outline"}
                                        size="sm"
                                        disabled={!target}
                                        onClick={() => setPicked(target ?? null)}
                                        aria-pressed={isSubscribed}
                                    >
                                        <span className="font-mono">{item.repo}</span>
                                        {kinds.map((kind) => (
                                            <Badge key={kind} variant={kindVariant(kind)}>
                                                {kindLabel(kind)}
                                            </Badge>
                                        ))}
                                        <span className="text-[length:var(--fs-2xs)]">
                                            {live.length > 0 ? `运行中 ${live.length}` : "已结束"}
                                            {isSubscribed ? "" : ", 缓存于 " + dateTime(item.at)}
                                        </span>
                                    </Button>
                                );
                            })
                        )}
                    </div>
                </CardContent>
            </Card>

            {current ? (
                <>
                    <Card>
                        <CardHeader className="flex flex-row flex-wrap items-center gap-2">
                            <CardTitle className="font-mono">{current.repo}</CardTitle>
                            <Badge variant={kindVariant(current.kind)}>{kindLabel(current.kind)}</Badge>
                            <span className="font-mono text-[length:var(--fs-2xs)] text-muted-foreground">
                                {current.runId}
                            </span>
                            <span className="ml-auto text-[length:var(--fs-2xs)] text-muted-foreground">
                                开始 {dateTime(current.startedAt)}, 最近更新 {dateTime(current.lastAt)}
                            </span>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-2">
                            <StageBar run={current} />
                            {current.done ? (
                                <p className="text-[length:var(--fs-xs)]">
                                    运行结束: {current.done.complete ? "完整" : "未完成"}
                                    {current.done.status ? ` (${current.done.status})` : ""}, 发现{" "}
                                    {current.done.counts.findings}, 错误{" "}
                                    <span className={current.done.counts.errors > 0 ? "text-danger-fg" : ""}>
                                        {current.done.counts.errors}
                                    </span>
                                    , 告警{" "}
                                    <span className={current.done.counts.warnings > 0 ? "text-warning-fg" : ""}>
                                        {current.done.counts.warnings}
                                    </span>
                                    {current.done.durationMs !== undefined
                                        ? ", 用时 " + duration(current.done.durationMs)
                                        : ""}
                                </p>
                            ) : null}
                        </CardContent>
                    </Card>
                    <LogPanel key={current.runId} run={current} />
                    <Card>
                        <CardHeader>
                            <CardTitle>本次运行的发现 ({current.findings.length})</CardTitle>
                        </CardHeader>
                        <CardContent className="px-0 pb-0">
                            <DataTable
                                bare
                                maxHeight="24rem"
                                rowKey={(row) => row.seq}
                                rows={current.findings}
                                columns={FINDING_COLUMNS}
                                emptyText="本次运行还没有产出发现"
                            />
                        </CardContent>
                    </Card>
                </>
            ) : null}
        </div>
    );
}
