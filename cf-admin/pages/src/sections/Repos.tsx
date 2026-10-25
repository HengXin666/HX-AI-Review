import { useState } from "react";
import type { FocusEvent, FormEvent } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, DataTable, Input, Switch } from "@hx/ui";
import type { DataTableColumn } from "@hx/ui";
import type { Repo, RepoInput } from "../api.ts";
import { repoKindOf } from "../api.ts";
import { repoKindLabel } from "../kind.ts";
import { usd } from "../format.ts";

const KIND_OPTIONS = ["context", "code", "both"] as const;

/**
 * An empty or invalid budget never becomes 0: 0 means "no cap" on the server, so a cleared box
 * would silently remove the spending limit. The old value is restored instead.
 */
function budgetBlur(repo: Repo, onChange: (patch: Partial<Repo>) => void) {
    return (event: FocusEvent<HTMLInputElement>) => {
        const raw = event.target.value.trim();
        const value = Number(raw);
        if (raw === "" || !Number.isFinite(value) || value < 0) {
            event.target.value = String(repo.budgetUsd);
            return;
        }
        if (value !== repo.budgetUsd) {
            onChange({ budgetUsd: value });
        }
    };
}

/** Kind is a repo-level choice: one review, or both. A single run is still always one kind. */
function kindSelect(repo: Repo, onChange: (patch: Partial<Repo>) => void) {
    return (
        <select
            aria-label="CR 类型"
            className="h-7 rounded-lg border border-border bg-card px-2 text-[length:var(--fs-xs)] text-foreground"
            value={repoKindOf(repo.kind)}
            onChange={(event) => onChange({ kind: event.target.value as Repo["kind"] })}
        >
            {KIND_OPTIONS.map((option) => (
                <option key={option} value={option}>
                    {repoKindLabel(option)}
                </option>
            ))}
        </select>
    );
}

type Props = {
    repos: Repo[];
    onChange: (name: string, patch: Partial<Repo>) => void;
    onCreate: (input: RepoInput) => Promise<string | null>;
    onRotate: (name: string) => Promise<string | null>;
};

export function Repos({ repos, onChange, onCreate, onRotate }: Props) {
    const [token, setToken] = useState<{ repo: string; value: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const create = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const text = (key: string) => String(data.get(key) ?? "").trim();
        // Only an explicitly empty budget means "no cap"; anything invalid is rejected, never turned into 0.
        const rawBudget = text("budgetUsd");
        const budget = rawBudget === "" ? 0 : Number(rawBudget);
        if (!Number.isFinite(budget) || budget < 0) {
            setError("月度预算必须是非负数, 留空表示不设上限");
            return;
        }
        setError(null);
        const input: RepoInput = {
            name: text("name"),
            provider: text("provider") || "default",
            finderModel: text("finderModel"),
            verifierModel: text("verifierModel"),
            budgetUsd: budget,
            kind: (text("kind") || "context") as RepoInput["kind"],
        };
        const value = await onCreate(input);
        form.reset();
        setToken(value ? { repo: input.name, value } : null);
    };
    const rotate = async (name: string) => {
        if (window.confirm(`轮换 ${name} 的 HX_CTX_TOKEN? 旧令牌会立即失效。`)) {
            const value = await onRotate(name);
            setToken(value ? { repo: name, value } : null);
        }
    };

    const columns: DataTableColumn<Repo>[] = [
        {
            key: "name",
            header: "仓库",
            width: "16rem",
            render: (repo) => <span className="font-mono text-[length:var(--fs-xs)]">{repo.name}</span>,
        },
        {
            key: "enabled",
            header: "启用",
            width: "5rem",
            render: (repo) => (
                <Switch
                    aria-label={`启用 ${repo.name}`}
                    checked={repo.enabled}
                    onCheckedChange={(checked) => onChange(repo.name, { enabled: checked === true })}
                />
            ),
        },
        {
            key: "kind",
            header: "CR 类型",
            width: "8rem",
            render: (repo) => kindSelect(repo, (patch) => onChange(repo.name, patch)),
        },
        {
            key: "mode",
            header: "模式",
            width: "6rem",
            render: (repo) => (
                <select
                    aria-label="运行模式"
                    className="h-7 rounded-lg border border-border bg-card px-2 text-[length:var(--fs-xs)] text-foreground"
                    value={repo.mode}
                    onChange={(event) => onChange(repo.name, { mode: event.target.value as Repo["mode"] })}
                >
                    <option value="full">full</option>
                    <option value="l0">l0</option>
                </select>
            ),
        },
        {
            key: "models",
            header: "finder / verifier",
            width: "16rem",
            render: (repo) => (
                <span className="font-mono text-[length:var(--fs-2xs)] text-muted-foreground">
                    {repo.finderModel} / {repo.verifierModel}
                </span>
            ),
        },
        {
            key: "budget",
            header: "已花 / 预算",
            width: "12rem",
            render: (repo) => (
                <span className="flex items-center gap-1 tabular-nums">
                    <span className={repo.budgetUsd > 0 && repo.spentUsd >= repo.budgetUsd ? "text-danger-fg" : ""}>
                        {usd(repo.spentUsd)}
                    </span>
                    <span className="text-muted-foreground">/</span>
                    <input
                        type="number"
                        min={0}
                        step={1}
                        aria-label={`${repo.name} 月度预算`}
                        defaultValue={repo.budgetUsd}
                        className="w-16 rounded-lg border border-border bg-transparent px-1.5 text-right"
                        onBlur={budgetBlur(repo, (patch) => onChange(repo.name, patch))}
                    />
                    <span className="text-[length:var(--fs-2xs)] text-muted-foreground">USD</span>
                </span>
            ),
        },
        {
            key: "lastSha",
            header: "last_sha",
            width: "9rem",
            render: (repo) => (
                <span className="font-mono text-[length:var(--fs-2xs)] text-muted-foreground">
                    {repo.lastSha?.slice(0, 10) ?? "-"}
                </span>
            ),
        },
        {
            key: "token",
            header: "令牌",
            width: "6rem",
            render: (repo) => (
                <Button type="button" variant="outline" size="xs" onClick={() => rotate(repo.name)}>
                    轮换
                </Button>
            ),
        },
    ];

    return (
        <Card>
            <CardHeader className="flex flex-row items-center gap-2">
                <CardTitle>仓库 ({repos.length})</CardTitle>
                <span className="ml-auto text-[length:var(--fs-2xs)] text-muted-foreground">
                    last_sha 只对上下文 CR 有意义
                </span>
            </CardHeader>
            <CardContent className="px-0 pb-0">
                <DataTable
                    bare
                    rowKey={(repo) => repo.name}
                    rows={repos}
                    columns={columns}
                    emptyText="还没有登记仓库"
                />
            </CardContent>
            <CardContent className="flex flex-col gap-2 border-t border-border/50">
                <form onSubmit={create} className="flex flex-wrap items-center gap-2">
                    <Input name="name" placeholder="owner/repo" required className="w-44" aria-label="仓库名" />
                    <Input name="provider" placeholder="供应商 (default)" className="w-40" aria-label="供应商" />
                    <Input
                        name="finderModel"
                        placeholder="finder 模型"
                        required
                        className="w-36"
                        aria-label="finder 模型"
                    />
                    <Input
                        name="verifierModel"
                        placeholder="verifier 模型"
                        required
                        className="w-36"
                        aria-label="verifier 模型"
                    />
                    <Input
                        name="budgetUsd"
                        placeholder="月度预算 USD (留空不设上限)"
                        className="w-52"
                        inputMode="decimal"
                        aria-label="月度预算"
                    />
                    <select
                        name="kind"
                        aria-label="CR 类型"
                        defaultValue="context"
                        className="h-8 rounded-lg border border-border bg-card px-2 text-[length:var(--fs-xs)] text-foreground"
                    >
                        {KIND_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                                {repoKindLabel(option)}
                            </option>
                        ))}
                    </select>
                    <Button type="submit" variant="primary">
                        登记仓库
                    </Button>
                </form>
                <p className="text-[length:var(--fs-2xs)] text-muted-foreground">
                    预算留空表示不设上限; 非法数字会被拒绝, 不会静默变成 0。
                </p>
                {error ? (
                    <p role="alert" className="text-[length:var(--fs-xs)] text-danger-fg">
                        {error}
                    </p>
                ) : null}
                {token ? (
                    <div className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/10 p-2 text-[length:var(--fs-xs)]">
                        <span>{token.repo} 的 HX_CTX_TOKEN 只显示这一次, 现在保存为仓库 secret:</span>
                        <code className="break-all font-mono text-foreground">{token.value}</code>
                        <Badge variant="warning" className="w-fit">
                            关闭后无法再次查看
                        </Badge>
                    </div>
                ) : null}
            </CardContent>
        </Card>
    );
}
