import { useEffect, useState } from "react";
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
    CodeBlock,
    EmptyState,
    Input,
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
    Stepper,
} from "@hx/ui";
import { kindOf } from "../api.ts";
import type { Finding, Run } from "../api.ts";
import { duration, shortSha, usd } from "../format.ts";
import { kindLabel, kindVariant } from "../kind.ts";
import { groupByDirectory, hasEvidence, lineUrl, pullUrl, stagesFor } from "../review-model.ts";
import { severityLabel, severityVariant, statusLabel, statusVariant } from "../status.ts";
import { CodeTrace } from "./CodeTrace.tsx";

type Props = {
    runId: string;
    runs: Run[];
    findings: Finding[];
    onBack: () => void;
    onVerdict: (id: string, verdict: "accepted" | "rejected", reason: string) => void;
};

function findingSort(a: Finding, b: Finding): number {
    return a.path.localeCompare(b.path) || a.line - b.line;
}

/** One run, opened from `#/runs/<id>`: stages, files, and the evidence the runner actually sent. */
export function Review({ runId, runs, findings, onBack, onVerdict }: Props) {
    const run = runs.find((item) => item.id === runId);
    const [reasons, setReasons] = useState<Record<string, string>>({});
    const [path, setPath] = useState<string | null>(null);

    const mine = findings
        .filter((item) => item.runId === runId)
        .slice()
        .sort(findingSort);
    const groups = groupByDirectory(mine);
    const selected = path ?? groups[0]?.files[0]?.path ?? null;
    const fileFindings = mine.filter((item) => item.path === selected);
    const missing = mine.filter((item) => !hasEvidence(item)).length;
    const stages = run ? stagesFor(kindOf(run.kind), run.status, missing) : null;

    useEffect(() => {
        setPath(null);
    }, [runId]);

    if (!run || !stages) {
        return (
            <Card>
                <CardHeader className="flex flex-row items-center gap-2">
                    <CardTitle>这次审查不在最近的列表里</CardTitle>
                    <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={onBack}>
                        返回列表
                    </Button>
                </CardHeader>
                <CardContent>
                    <EmptyState compact text="最近 50 次运行里没有这一条" hint="更早的运行还没有单独的详情接口。" />
                </CardContent>
            </Card>
        );
    }

    const kind = kindOf(run.kind);
    const caption =
        run.status === "incomplete" || run.status === "skipped"
            ? "运行还没结束。runner 没有上报停在哪一步，所以进度停在第一步。"
            : missing > 0
              ? "有发现没有证据引用。证据校验这一步不算过，页面也不会叫你自己去对上下文。"
              : kind === "code"
                ? "步骤按这次运行的结果标完。下面是上报里的 diff 分组和证据校验，包括删除行、档位，以及被评论预算抑制的候选。"
                : "步骤按这次运行的结果标完。上下文补丁仍然从发现上的补丁链接打开。";

    const files = (
        <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
            {groups.length === 0 ? (
                <EmptyState
                    compact
                    text="这次运行没有可展示的发现"
                    hint="已接受或已驳回的不在总览接口里。仍待处理或已被后续提交解决的会出现在这里。"
                />
            ) : (
                groups.map((group) => (
                    <div key={group.name} className="flex flex-col gap-1">
                        <div className="px-1 text-[length:var(--fs-2xs)] text-muted-foreground">{group.name}</div>
                        {group.files.map((file) => {
                            const active = file.path === selected;
                            const bare = file.findings.some((item) => !hasEvidence(item));
                            return (
                                <button
                                    key={file.path}
                                    type="button"
                                    onClick={() => setPath(file.path)}
                                    className={
                                        "flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors " +
                                        (active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60")
                                    }
                                >
                                    <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-xs)]">
                                        {file.path}
                                    </span>
                                    <Badge variant={bare ? "warning" : "secondary"}>{file.findings.length}</Badge>
                                </button>
                            );
                        })}
                    </div>
                ))
            )}
        </div>
    );

    const detail = (
        <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
            {fileFindings.length === 0 ? (
                <EmptyState compact text="选一个文件" hint="左侧是这次运行上报的文件，按目录分组。" />
            ) : (
                fileFindings.map((item) => (
                    <article key={item.id} className="flex flex-col gap-2 rounded-xl border border-border/50 p-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={severityVariant(item.severity)}>{severityLabel(item.severity)}</Badge>
                            <span className="font-mono text-[length:var(--fs-xs)]">{item.ruleId}</span>
                            <a
                                className="font-mono text-[length:var(--fs-xs)] text-link underline-offset-4 hover:underline"
                                href={lineUrl(run.repo, run.sha, item.path, item.line)}
                                target="_blank"
                                rel="noreferrer"
                            >
                                :{item.line}
                            </a>
                            {item.status && item.status !== "open" ? (
                                <Badge variant={statusVariant(item.status)}>{statusLabel(item.status)}</Badge>
                            ) : null}
                        </div>
                        <p className="text-[length:var(--fs-sm)] leading-relaxed">{item.message}</p>
                        {hasEvidence(item) ? (
                            <CodeBlock
                                code={item.evidence ?? ""}
                                lang="text"
                                title="证据引用"
                                showLineNumbers={Boolean(item.evidence?.includes("\n"))}
                            />
                        ) : (
                            <Alert variant="danger">
                                <AlertTitle>没有证据引用</AlertTitle>
                                <AlertDescription>
                                    这条发现没有给出能在 diff 或上下文里对上的引用，所以它不能算已经核验过。
                                </AlertDescription>
                            </Alert>
                        )}
                        {item.status === undefined || item.status === "open" ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                                <Input
                                    value={reasons[item.id] ?? ""}
                                    placeholder="驳回原因"
                                    aria-label="驳回原因"
                                    className="w-48"
                                    onChange={(event) =>
                                        setReasons((current) => ({ ...current, [item.id]: event.target.value }))
                                    }
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => onVerdict(item.id, "accepted", "")}
                                >
                                    接受
                                </Button>
                                <Button
                                    type="button"
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => onVerdict(item.id, "rejected", reasons[item.id] ?? "")}
                                >
                                    驳回
                                </Button>
                            </div>
                        ) : null}
                    </article>
                ))
            )}
        </div>
    );

    return (
        <div className="flex flex-col gap-3">
            <Card>
                <CardHeader className="flex flex-row flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={onBack}>
                        返回
                    </Button>
                    <CardTitle className="font-mono text-[length:var(--fs-sm)]">
                        {run.repo} {shortSha(run.sha)}
                    </CardTitle>
                    <Badge variant={kindVariant(kind)}>{kindLabel(kind)}</Badge>
                    <Badge variant={statusVariant(run.status)}>{statusLabel(run.status)}</Badge>
                    {run.prNumber ? (
                        <a
                            className="text-[length:var(--fs-xs)] text-link underline-offset-4 hover:underline"
                            href={pullUrl(run.repo, run.prNumber)}
                            target="_blank"
                            rel="noreferrer"
                        >
                            PR #{run.prNumber}
                        </a>
                    ) : null}
                    <span className="ml-auto tabular-nums text-[length:var(--fs-2xs)] text-muted-foreground">
                        {usd(run.costUsd, 3)} · {duration(run.durationMs)} · {mine.length} 条发现
                        {missing > 0 ? ` · ${missing} 条缺证据` : ""}
                    </span>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    <Stepper steps={stages.stages} current={stages.current} />
                    <p className="text-[length:var(--fs-xs)] text-muted-foreground">{caption}</p>
                </CardContent>
            </Card>

            {kind === "code" ? <CodeTrace repo={run.repo} id={run.id} /> : null}

            <div className="flex flex-col gap-3 lg:hidden">
                <Card>
                    <CardHeader>
                        <CardTitle>文件</CardTitle>
                    </CardHeader>
                    <CardContent className="px-0">{files}</CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>{selected ?? "发现"}</CardTitle>
                    </CardHeader>
                    <CardContent className="px-0">{detail}</CardContent>
                </Card>
            </div>

            <Card className="hidden h-[36rem] lg:block">
                <ResizablePanelGroup orientation="horizontal" className="h-full">
                    <ResizablePanel defaultSize="32" minSize="20">
                        {files}
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel defaultSize="68" minSize="40">
                        {detail}
                    </ResizablePanel>
                </ResizablePanelGroup>
            </Card>
        </div>
    );
}
