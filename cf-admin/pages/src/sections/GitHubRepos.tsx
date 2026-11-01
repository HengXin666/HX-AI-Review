import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle, Badge, Button, DataTable, EmptyState, MotionSelect } from "@hx/ui";
import type { DataTableColumn } from "@hx/ui";
import { GITHUB_REPOS_PER_PAGE, githubConnectApi, isNotReady, repoKindOf } from "../api.ts";
import type { GitHubEnableStep, GitHubRepoStatus, RepoKind } from "../api.ts";

const NOT_READY = "后端未就绪: 仓库接口返回 404, 对应的 Worker 路由可能尚未部署.";

const KIND_OPTIONS: { value: RepoKind; label: string }[] = [
    { value: "context", label: "context" },
    { value: "code", label: "code" },
    { value: "both", label: "both" },
];

type ManualSecret = { name: string; value: string };

type RowRun = {
    busy: "enable" | "disable" | null;
    steps: GitHubEnableStep[] | null;
    error: string | null;
    /** One-time runner token to set by hand when enable could not write the secret; kept only in page state. */
    secret: ManualSecret | null;
};

const IDLE: RowRun = { busy: null, steps: null, error: null, secret: null };

function errorText(error: unknown): string {
    if (isNotReady(error)) {
        return NOT_READY;
    }
    return error instanceof Error ? error.message : String(error);
}

function Flag({ on, yes, no }: { on: boolean; yes: string; no: string }) {
    return <Badge variant={on ? "success" : "secondary"}>{on ? yes : no}</Badge>;
}

/** The runner token enable could not write: shown once, never re-fetchable, same wording as the Repos page. */
function ManualSecretBox({ repo, secret }: { repo: string; secret: ManualSecret }) {
    return (
        <div className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/10 p-2 text-[length:var(--fs-2xs)]">
            <span>
                未能自动写入 secret. 请在 {repo} 的仓库设置中新建 secret{" "}
                <span className="font-mono">{secret.name}</span>, 值为:
            </span>
            <code className="break-all font-mono text-foreground">{secret.value}</code>
            <Badge variant="warning" className="w-fit">
                只显示这一次, 刷新或离开后无法再次查看
            </Badge>
        </div>
    );
}

function Steps({ run }: { run: RowRun }) {
    if (run.error) {
        return <span className="text-[length:var(--fs-2xs)] text-danger-fg">{run.error}</span>;
    }
    if (!run.steps) {
        return null;
    }
    return (
        <ul className="flex flex-col gap-0.5 text-[length:var(--fs-2xs)]">
            {run.steps.map((step, index) => (
                <li key={index} className={step.ok ? "text-success-fg" : "text-danger-fg"}>
                    {step.ok ? "[成功] " : "[失败] "}
                    {step.name}
                    {step.message ? ": " + step.message : ""}
                </li>
            ))}
        </ul>
    );
}

/**
 * Repositories one installation reaches, each with a one-click enable / disable.
 * Changing kind on an enabled repo re-runs enable once with the new kind, which overwrites the old setup.
 * Paged 32 at a time (fixed); changing page re-reads that page from the Worker.
 */
export function GitHubRepos({ installationId }: { installationId: number }) {
    const [repos, setRepos] = useState<GitHubRepoStatus[] | null>(null);
    const [page, setPage] = useState(1);
    const [totalCount, setTotalCount] = useState(0);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [kinds, setKinds] = useState<Record<string, RepoKind>>({});
    const [runs, setRuns] = useState<Record<string, RowRun>>({});

    const load = useCallback(() => {
        setRepos(null);
        setLoadError(null);
        githubConnectApi.repos(installationId, page).then(
            (body) => {
                setRepos(body.repos);
                setTotalCount(body.totalCount);
            },
            (error: unknown) => setLoadError(errorText(error)),
        );
    }, [installationId, page]);

    useEffect(() => {
        setPage(1);
        setKinds({});
        setRuns({});
    }, [installationId]);

    useEffect(() => {
        load();
    }, [load]);

    const totalPages = Math.max(1, Math.ceil(totalCount / GITHUB_REPOS_PER_PAGE));

    const patchRun = (name: string, next: Partial<RowRun>) =>
        setRuns((prev) => ({ ...prev, [name]: { ...(prev[name] ?? IDLE), ...next } }));

    /** Re-read the list and swap in just this row, so other rows keep their step output. */
    const refreshRow = (name: string) => {
        githubConnectApi.repos(installationId, page).then(
            (body) => {
                const fresh = body.repos.find((repo) => repo.fullName === name);
                if (fresh) {
                    setRepos((prev) => (prev ? prev.map((repo) => (repo.fullName === name ? fresh : repo)) : prev));
                }
            },
            () => undefined,
        );
    };

    const kindOfRow = (row: GitHubRepoStatus): RepoKind => kinds[row.fullName] ?? repoKindOf(row.kind);

    const enable = (row: GitHubRepoStatus, kind: RepoKind) => {
        const name = row.fullName;
        patchRun(name, { busy: "enable", steps: null, error: null, secret: null });
        githubConnectApi.enable({ fullName: name, kind, installationId }).then(
            (result) => {
                patchRun(name, { busy: null, steps: result.steps, error: null, secret: result.manualSecret ?? null });
                refreshRow(name);
            },
            (error: unknown) => patchRun(name, { busy: null, error: errorText(error) }),
        );
    };

    const disable = (row: GitHubRepoStatus) => {
        const name = row.fullName;
        patchRun(name, { busy: "disable", steps: null, error: null, secret: null });
        githubConnectApi.disable(name).then(
            () => {
                patchRun(name, { busy: null });
                refreshRow(name);
            },
            (error: unknown) => patchRun(name, { busy: null, error: errorText(error) }),
        );
    };

    const changeKind = (row: GitHubRepoStatus, value: string) => {
        const kind = repoKindOf(value);
        setKinds((prev) => ({ ...prev, [row.fullName]: kind }));
        if (row.enabled && kind !== repoKindOf(row.kind)) {
            enable(row, kind);
        }
    };

    const columns: DataTableColumn<GitHubRepoStatus>[] = [
        {
            key: "fullName",
            header: "仓库",
            render: (row) => (
                <a
                    href={"https://github.com/" + row.fullName}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono underline-offset-2 hover:underline"
                >
                    {row.fullName}
                </a>
            ),
        },
        {
            key: "private",
            header: "可见性",
            width: "6rem",
            render: (row) => <Badge variant="secondary">{row.private ? "私有" : "公开"}</Badge>,
        },
        {
            key: "kind",
            header: "kind",
            width: "9rem",
            render: (row) => (
                <MotionSelect
                    value={kindOfRow(row)}
                    onValueChange={(value) => changeKind(row, value)}
                    options={KIND_OPTIONS}
                    disabled={Boolean(runs[row.fullName]?.busy)}
                    aria-label={"kind of " + row.fullName}
                />
            ),
        },
        {
            key: "workflow",
            header: "工作流",
            width: "7rem",
            render: (row) => <Flag on={row.workflowInstalled} yes="已写入" no="未写入" />,
        },
        {
            key: "secret",
            header: "Secret",
            width: "7rem",
            render: (row) => <Flag on={row.secretInstalled} yes="已配置" no="未配置" />,
        },
        {
            key: "action",
            header: "操作",
            width: "18rem",
            render: (row) => {
                const run = runs[row.fullName] ?? IDLE;
                return (
                    <div className="flex flex-col gap-1">
                        {row.enabled ? (
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={run.busy !== null}
                                onClick={() => disable(row)}
                            >
                                {run.busy === "disable"
                                    ? "停用中..."
                                    : run.busy === "enable"
                                      ? "重新启用中..."
                                      : "停用"}
                            </Button>
                        ) : (
                            <Button
                                type="button"
                                variant="primary"
                                size="sm"
                                disabled={run.busy !== null}
                                onClick={() => enable(row, kindOfRow(row))}
                            >
                                {run.busy === "enable" ? "启用中..." : "启用"}
                            </Button>
                        )}
                        <Steps run={run} />
                        {run.secret ? <ManualSecretBox repo={row.fullName} secret={run.secret} /> : null}
                    </div>
                );
            },
        },
    ];

    if (loadError) {
        return (
            <div className="flex flex-col gap-2 px-4 pb-4">
                <Alert variant={loadError === NOT_READY ? "warning" : "danger"}>
                    <AlertTitle>{loadError === NOT_READY ? "后端未就绪" : "读取仓库失败"}</AlertTitle>
                    <AlertDescription>{loadError}</AlertDescription>
                </Alert>
                <div>
                    <Button type="button" variant="ghost" size="xs" onClick={load}>
                        重试
                    </Button>
                </div>
            </div>
        );
    }
    if (!repos) {
        return (
            <div className="px-4 pb-4">
                <EmptyState kind="loading" text="读取仓库列表..." compact />
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-2">
            <p className="px-4 text-[length:var(--fs-2xs)] text-muted-foreground">
                启用会在仓库写入工作流并配置 Secret. 已启用的仓库修改 kind 后会立即用新 kind 重新启用一次, 覆盖原配置.
            </p>
            <div className="flex items-center justify-between gap-2 px-4 text-[length:var(--fs-2xs)]">
                <span className="text-muted-foreground">
                    第 {page} 页, 共 {totalCount} 个仓库 (每页 {GITHUB_REPOS_PER_PAGE} 个, 共 {totalPages} 页)
                </span>
                <div className="flex gap-1">
                    <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={page <= 1}
                        onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                        上一页
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={page >= totalPages}
                        onClick={() => setPage((current) => current + 1)}
                    >
                        下一页
                    </Button>
                </div>
            </div>
            <DataTable
                bare
                rowKey={(row) => row.fullName}
                rows={repos}
                columns={columns}
                emptyText="这个安装还没有可访问的仓库"
            />
        </div>
    );
}
