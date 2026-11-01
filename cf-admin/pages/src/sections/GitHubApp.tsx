import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
    Alert,
    AlertDescription,
    AlertTitle,
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    DataTable,
    EmptyState,
    Input,
    MotionSelect,
    Textarea,
} from "@hx/ui";
import type { DataTableColumn } from "@hx/ui";
import { githubApi, githubConnectApi, isNotReady } from "../api.ts";
import type {
    GitHubAppInfo,
    GitHubAppInput,
    GitHubAppView,
    GitHubInstallation,
    GitHubManifestStart,
    GitHubVerifyResult,
} from "../api.ts";
import { dateTime } from "../format.ts";
import { GitHubRepos } from "./GitHubRepos.tsx";

/** Permissions and events the App must be created with. Names are GitHub's own and stay in English. */
const PERMISSIONS = [
    ["Contents", "read"],
    ["Pull requests", "write"],
    ["Issues", "write"],
] as const;
const EVENTS = ["push", "pull_request", "installation", "installation_repositories"] as const;

const NOT_READY = "后端未就绪: 该接口返回 404, 对应的 Worker 路由可能尚未部署.";

type Load<T> =
    { state: "loading" } | { state: "ready"; value: T } | { state: "notReady" } | { state: "error"; message: string };

function settle<T>(promise: Promise<T>, set: (next: Load<T>) => void): void {
    promise.then(
        (value) => set({ state: "ready", value }),
        (error: unknown) => {
            if (isNotReady(error)) {
                set({ state: "notReady" });
                return;
            }
            set({ state: "error", message: error instanceof Error ? error.message : String(error) });
        },
    );
}

function errorText(error: unknown): string {
    if (isNotReady(error)) {
        return NOT_READY;
    }
    return error instanceof Error ? error.message : String(error);
}

function RepoList({ repos }: { repos: GitHubInstallation["repos"] }) {
    if (repos.length === 0) {
        return <span className="text-muted-foreground">-</span>;
    }
    return (
        <div className="flex flex-wrap gap-1">
            {repos.map((repo) => (
                <span key={repo.fullName} className="inline-flex items-center gap-1">
                    <span className="font-mono text-[length:var(--fs-2xs)]">{repo.fullName}</span>
                    <Badge variant={repo.registered ? "success" : "secondary"}>
                        {repo.registered ? "已登记" : "未登记"}
                    </Badge>
                </span>
            ))}
        </div>
    );
}

const INSTALL_COLUMNS: DataTableColumn<GitHubInstallation>[] = [
    {
        key: "installationId",
        header: "安装 ID",
        width: "8rem",
        render: (row) => <span className="font-mono">{row.installationId}</span>,
    },
    {
        key: "account",
        header: "账号",
        width: "14rem",
        render: (row) => (
            <span className="inline-flex items-center gap-1">
                <span className="font-mono">{row.account}</span>
                {row.accountType ? <Badge variant="secondary">{row.accountType}</Badge> : null}
                {row.suspended ? <Badge variant="warning">已暂停</Badge> : null}
            </span>
        ),
    },
    {
        key: "repos",
        header: "仓库",
        render: (row) => <RepoList repos={row.repos} />,
    },
];

/** Copy with the Clipboard API; on an insecure origin it is missing, so the user is told to copy by hand. */
function CopyField({ value, label }: { value: string; label: string }) {
    const [note, setNote] = useState<string | null>(null);
    const copy = () => {
        if (!navigator.clipboard) {
            setNote("当前页面不支持自动复制, 请手动选中复制");
            return;
        }
        navigator.clipboard.writeText(value).then(
            () => setNote("已复制"),
            () => setNote("复制失败, 请手动选中复制"),
        );
    };
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Input
                readOnly
                value={value}
                aria-label={label}
                className="w-full max-w-xl font-mono"
                onFocus={(e) => e.currentTarget.select()}
            />
            <Button type="button" variant="outline" size="sm" onClick={copy}>
                复制
            </Button>
            {note ? <span className="text-[length:var(--fs-2xs)] text-muted-foreground">{note}</span> : null}
        </div>
    );
}

function StatusCard({ app }: { app: Load<GitHubAppInfo> }) {
    if (app.state === "loading") {
        return <EmptyState kind="loading" text="读取 GitHub App 配置..." compact />;
    }
    if (app.state === "notReady") {
        return (
            <Alert variant="warning">
                <AlertTitle>后端未就绪</AlertTitle>
                <AlertDescription>{NOT_READY} 仍可先填写下方表单, 接口上线后再保存.</AlertDescription>
            </Alert>
        );
    }
    if (app.state === "error") {
        return (
            <Alert variant="danger">
                <AlertTitle>读取配置失败</AlertTitle>
                <AlertDescription>{app.message}</AlertDescription>
            </Alert>
        );
    }
    const info = app.value;
    const view = info.app;
    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-center gap-2">
                <CardTitle>当前配置</CardTitle>
                <Badge variant={info.configured ? "success" : "warning"}>{info.configured ? "已配置" : "未配置"}</Badge>
                {view ? (
                    <Badge variant={view.status === "invalid" ? "destructive" : "secondary"}>{view.status}</Badge>
                ) : null}
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-1 text-[length:var(--fs-xs)] md:grid-cols-2">
                <span>
                    appId: <span className="font-mono">{view?.appId ?? "-"}</span>
                </span>
                <span>
                    slug: <span className="font-mono">{view?.slug || "-"}</span>
                </span>
                {/* The login reviews actually appear as. Without it an admin cannot tell whether a comment will
                    come from the App or from github-actions[bot]. */}
                <span>
                    评论身份: <span className="font-mono">{view?.slug ? view.slug + "[bot]" : "-"}</span>
                </span>
                <span>
                    clientId: <span className="font-mono">{view?.clientId || "-"}</span>
                </span>
                <span>
                    workflowFile: <span className="font-mono">{view?.workflowFile || "-"}</span>
                </span>
                <span>安装时间: {view?.installedAt ? dateTime(view.installedAt) : "-"}</span>
                <span>
                    私钥 {view?.hasPrivateKey ? "已存" : "未存"}, client secret{" "}
                    {view?.hasClientSecret ? "已存" : "未存"}, webhook secret {view?.hasWebhookSecret ? "已存" : "未存"}
                </span>
            </CardContent>
        </Card>
    );
}

const TEXT_FIELDS = ["appId", "slug", "clientId", "workflowFile", "clientSecret", "webhookSecret"] as const;

/**
 * Secret fields are write-only: never prefilled, and an empty one is left out so the stored value is kept.
 * appId and slug are required on every save; a first save also needs the private key and webhook secret,
 * since the Worker only reports configured once both are stored.
 */
function readForm(
    form: HTMLFormElement,
    privateKey: string,
    view: GitHubAppView | null,
): GitHubAppInput | { error: string } {
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const values: Partial<Record<(typeof TEXT_FIELDS)[number], string>> = {};
    for (const key of TEXT_FIELDS) {
        if (text(key)) {
            values[key] = text(key);
        }
    }
    const appId = values.appId ?? "";
    const slug = values.slug ?? "";
    if (!/^\d+$/.test(appId)) {
        return { error: "appId 必须是纯数字" };
    }
    if (!slug) {
        return { error: "slug 不能为空" };
    }
    const input: GitHubAppInput = { appId, slug };
    if (values.clientId) {
        input.clientId = values.clientId;
    }
    if (values.workflowFile) {
        input.workflowFile = values.workflowFile;
    }
    if (values.clientSecret) {
        input.clientSecret = values.clientSecret;
    }
    if (values.webhookSecret) {
        if (values.webhookSecret.length < 16) {
            return { error: "webhookSecret 至少 16 个字符" };
        }
        input.webhookSecret = values.webhookSecret;
    }
    if (privateKey) {
        input.privateKey = privateKey;
    }
    const missing: string[] = [];
    if (!input.privateKey && !view?.hasPrivateKey) {
        missing.push("privateKey");
    }
    if (!input.webhookSecret && !view?.hasWebhookSecret) {
        missing.push("webhookSecret");
    }
    if (missing.length > 0) {
        return { error: "首次配置需要填写, 缺少: " + missing.join(", ") };
    }
    return input;
}

type ManualProps = {
    app: Load<GitHubAppInfo>;
    installs: Load<GitHubInstallation[]>;
    load: () => void;
};

/** Advanced: the hand-filled credentials form, webhook URL, required permissions, verification and installs. */
function ManualConfig({ app, installs, load }: ManualProps) {
    const [privateKey, setPrivateKey] = useState("");
    const [draftKey, setDraftKey] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [verifying, setVerifying] = useState(false);
    const [verify, setVerify] = useState<GitHubVerifyResult | null>(null);
    const [verifyError, setVerifyError] = useState<string | null>(null);

    const view = app.state === "ready" ? app.value.app : null;
    const webhookUrl = app.state === "ready" ? app.value.webhookUrl : null;

    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const parsed = readForm(form, privateKey, view);
        setSaved(false);
        if ("error" in parsed) {
            setSaveError(parsed.error);
            return;
        }
        setSaveError(null);
        setSaving(true);
        githubApi.saveApp(parsed).then(
            () => {
                setSaving(false);
                setSaved(true);
                setPrivateKey("");
                form.reset();
                load();
            },
            (error: unknown) => {
                setSaving(false);
                setSaveError(errorText(error));
            },
        );
    };

    const runVerify = () => {
        setVerifying(true);
        setVerify(null);
        setVerifyError(null);
        githubApi.verifyApp().then(
            (result) => {
                setVerifying(false);
                setVerify(result);
                load();
            },
            (error: unknown) => {
                setVerifying(false);
                setVerifyError(errorText(error));
            },
        );
    };

    const commitKey = () => {
        if (draftKey.trim()) {
            setPrivateKey(draftKey.trim());
        }
        setDraftKey("");
    };

    return (
        <div className="flex flex-col gap-3">
            <StatusCard app={app} />

            <Card>
                <CardHeader>
                    <CardTitle>凭据</CardTitle>
                    <CardDescription>密钥类字段只写不读: 页面不会回显, 留空表示保持已保存的值.</CardDescription>
                </CardHeader>
                <CardContent>
                    <form onSubmit={submit} className="flex flex-col gap-2">
                        <div key={view ? view.updatedAt : "new"} className="grid grid-cols-1 gap-2 md:grid-cols-3">
                            <Input
                                name="appId"
                                placeholder="appId, 例如 123456"
                                inputMode="numeric"
                                aria-label="appId"
                                defaultValue={view?.appId ?? ""}
                            />
                            <Input
                                name="slug"
                                placeholder="slug, 例如 hx-context-review"
                                aria-label="slug"
                                defaultValue={view?.slug ?? ""}
                            />
                            <Input
                                name="clientId"
                                placeholder="clientId, 例如 Iv23li..."
                                aria-label="clientId"
                                defaultValue={view?.clientId ?? ""}
                            />
                            <Input
                                name="workflowFile"
                                placeholder="workflowFile, 例如 hx-context-review.yml"
                                aria-label="workflowFile"
                                defaultValue={view?.workflowFile ?? ""}
                            />
                            <Input
                                name="clientSecret"
                                type="password"
                                autoComplete="new-password"
                                placeholder={view?.hasClientSecret ? "clientSecret (已配置, 留空保持)" : "clientSecret"}
                                aria-label="clientSecret"
                            />
                            <Input
                                name="webhookSecret"
                                type="password"
                                autoComplete="new-password"
                                placeholder={
                                    view?.hasWebhookSecret
                                        ? "webhookSecret (已配置, 留空保持)"
                                        : "webhookSecret, 至少 16 字符"
                                }
                                aria-label="webhookSecret"
                            />
                        </div>
                        <div className="flex flex-col gap-1">
                            <span className="text-[length:var(--fs-xs)]">privateKey (PEM)</span>
                            {privateKey ? (
                                <div className="flex items-center gap-2">
                                    <Badge variant="success">已配置</Badge>
                                    <span className="text-[length:var(--fs-2xs)] text-muted-foreground">
                                        已读入, 保存时提交; 页面不显示内容
                                    </span>
                                    <Button type="button" variant="ghost" size="xs" onClick={() => setPrivateKey("")}>
                                        重新填写
                                    </Button>
                                </div>
                            ) : (
                                <>
                                    {view?.hasPrivateKey ? (
                                        <span className="text-[length:var(--fs-2xs)] text-muted-foreground">
                                            服务端已有私钥, 留空保持不变
                                        </span>
                                    ) : null}
                                    <Textarea
                                        aria-label="privateKey"
                                        rows={4}
                                        spellCheck={false}
                                        placeholder="粘贴 -----BEGIN RSA PRIVATE KEY----- ... 内容, 离开输入框后只显示 已配置"
                                        className="font-mono text-[length:var(--fs-2xs)]"
                                        value={draftKey}
                                        onChange={(e) => setDraftKey(e.currentTarget.value)}
                                        onBlur={commitKey}
                                    />
                                </>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Button type="submit" variant="primary" disabled={saving}>
                                {saving ? "保存中..." : "保存配置"}
                            </Button>
                            <Button type="button" variant="outline" disabled={verifying} onClick={runVerify}>
                                {verifying ? "校验中..." : "校验 GitHub 连接"}
                            </Button>
                            {saved ? <Badge variant="success">已保存</Badge> : null}
                        </div>
                        {saveError ? (
                            <Alert variant="danger">
                                <AlertTitle>保存失败</AlertTitle>
                                <AlertDescription>{saveError}</AlertDescription>
                            </Alert>
                        ) : null}
                        {verifyError ? (
                            <Alert variant="danger">
                                <AlertTitle>校验失败</AlertTitle>
                                <AlertDescription>{verifyError}</AlertDescription>
                            </Alert>
                        ) : null}
                        {verify ? (
                            <Alert variant="success">
                                <AlertTitle>校验通过</AlertTitle>
                                <AlertDescription>
                                    GitHub 接受了这组凭据 ({verify.app.name || verify.app.slug}
                                    {verify.app.owner ? ", 属于 " + verify.app.owner : ""}), 发现 {verify.installations}{" "}
                                    个安装.
                                </AlertDescription>
                            </Alert>
                        ) : null}
                    </form>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>在 GitHub 上填写</CardTitle>
                    <CardDescription>创建或编辑 GitHub App 时, 把回调地址, 权限与事件按下面填写.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-[length:var(--fs-xs)]">
                    <div className="flex flex-col gap-1">
                        <span>Webhook URL</span>
                        {webhookUrl ? (
                            <CopyField value={webhookUrl} label="Webhook URL" />
                        ) : (
                            <span className="text-muted-foreground">读取配置后显示后端给出的地址</span>
                        )}
                    </div>
                    <div className="flex flex-col gap-1">
                        <span>仓库权限 (Repository permissions)</span>
                        <div className="flex flex-wrap gap-1.5">
                            {PERMISSIONS.map(([name, level]) => (
                                <Badge key={name} variant="secondary">
                                    {name}: {level}
                                </Badge>
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-col gap-1">
                        <span>订阅事件 (Subscribe to events)</span>
                        <div className="flex flex-wrap gap-1.5">
                            {EVENTS.map((name) => (
                                <Badge key={name} variant="secondary">
                                    <span className="font-mono">{name}</span>
                                </Badge>
                            ))}
                        </div>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="flex flex-row items-center gap-2">
                    <CardTitle>已安装的仓库</CardTitle>
                    <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={load}>
                        刷新
                    </Button>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                    {installs.state === "ready" ? (
                        <DataTable
                            bare
                            rowKey={(row) => String(row.installationId)}
                            rows={installs.value}
                            columns={INSTALL_COLUMNS}
                            emptyText="还没有安装到任何账号或仓库"
                        />
                    ) : (
                        <div className="px-4 pb-4">
                            {installs.state === "loading" ? (
                                <EmptyState kind="loading" text="读取安装列表..." compact />
                            ) : installs.state === "notReady" ? (
                                <EmptyState kind="empty" text="后端未就绪" hint={NOT_READY} compact />
                            ) : (
                                <EmptyState kind="error" text="读取安装列表失败" hint={installs.message} compact />
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

// ---- Connect account + one-click enable ----

/** Where the manual path sends people who do not want the App. Repo and paths are fixed by the template's home. */
const MANUAL_SOURCE = "HengXin666/HX-AI-Review";
const MANUAL_TEMPLATE = "templates/hx-context-review.workflow.yml";
const MANUAL_TARGET = ".github/workflows/hx-context-review.yml";

type Callback = { connected: boolean; error: string | null };

/**
 * The backend 302s back to #/github?connected=1 or #/github?error=<reason>. App.tsx matches the hash
 * exactly, so the query has to be gone before it reads the hash; this runs at module load, which is
 * before App's first render, and rewrites the URL to plain #/github. A query in location.search is
 * accepted and cleared as well. URLSearchParams.get already URL-decodes the reason.
 */
function takeCallback(): Callback | null {
    if (typeof window === "undefined") {
        return null;
    }
    const { hash, search, pathname } = window.location;
    const hashMatch = /^#\/?github\?(.*)$/.exec(hash);
    const fromHash = new URLSearchParams(hashMatch ? hashMatch[1] : "");
    const fromSearch = new URLSearchParams(search);
    const pick = (key: string) => fromHash.get(key) ?? fromSearch.get(key);
    const connected = pick("connected") === "1";
    const error = pick("error");
    const searchHad = fromSearch.has("connected") || fromSearch.has("error");
    if (!hashMatch && !searchHad) {
        return null;
    }
    fromSearch.delete("connected");
    fromSearch.delete("error");
    const rest = fromSearch.toString();
    const nextHash = hashMatch ? "#/github" : hash;
    window.history.replaceState(null, "", pathname + (rest ? "?" + rest : "") + nextHash);
    if (!connected && !error) {
        return null;
    }
    return { connected, error: error || null };
}

let pendingCallback: Callback | null = takeCallback();

/** The manifest flow needs a real browser navigation to github.com, so it is a form submit, never fetch. */
function submitManifest(start: GitHubManifestStart): void {
    const form = document.createElement("form");
    form.method = "post";
    form.action = start.action;
    form.style.display = "none";
    const add = (name: string, value: string) => {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.appendChild(input);
    };
    add("manifest", JSON.stringify(start.manifest));
    add("state", start.state);
    document.body.appendChild(form);
    form.submit();
}

function statusVariant(status: string): string {
    if (status === "verified") {
        return "success";
    }
    return status === "invalid" ? "destructive" : "secondary";
}

function CallbackBanner({ callback, onClose }: { callback: Callback; onClose: () => void }) {
    return (
        <Alert variant={callback.error ? "danger" : "success"}>
            <AlertTitle>{callback.error ? "连接 GitHub 失败" : "已连接"}</AlertTitle>
            <AlertDescription>
                <span className="flex flex-wrap items-center gap-2">
                    {callback.error ? callback.error : "GitHub App 已创建并保存, 下一步把它安装到你的仓库."}
                    <Button type="button" variant="ghost" size="xs" onClick={onClose}>
                        关闭
                    </Button>
                </span>
            </AlertDescription>
        </Alert>
    );
}

function ConnectCard({ app, installCount }: { app: Load<GitHubAppInfo>; installCount: number | null }) {
    const [connecting, setConnecting] = useState(false);
    const [connectError, setConnectError] = useState<string | null>(null);

    const connect = () => {
        setConnecting(true);
        setConnectError(null);
        githubConnectApi.manifest().then(
            (start) => submitManifest(start),
            (error: unknown) => {
                setConnecting(false);
                setConnectError(errorText(error));
            },
        );
    };

    if (app.state === "loading") {
        return <EmptyState kind="loading" text="读取 GitHub 连接状态..." compact />;
    }
    if (app.state === "notReady") {
        return (
            <Alert variant="warning">
                <AlertTitle>后端未就绪</AlertTitle>
                <AlertDescription>{NOT_READY} 暂时可以用下方的手动接入方式.</AlertDescription>
            </Alert>
        );
    }
    const view = app.state === "ready" ? app.value.app : null;
    const connected = app.state === "ready" && (app.value.configured || view !== null);
    if (connected && view) {
        return (
            <Card>
                <CardHeader className="flex flex-row flex-wrap items-center gap-2">
                    <CardTitle>已连接 GitHub</CardTitle>
                    <Badge variant={statusVariant(view.status)}>{view.status}</Badge>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-4 text-[length:var(--fs-xs)]">
                    <span>
                        App: <span className="font-mono">{view.slug || "-"}</span>
                    </span>
                    <span>安装数: {installCount === null ? "-" : installCount}</span>
                </CardContent>
            </Card>
        );
    }
    return (
        <Card>
            <CardHeader>
                <CardTitle>连接 GitHub</CardTitle>
                <CardDescription>
                    跳转到 GitHub 授权, 自动创建并保存 App, 回来后即可逐个仓库一键启用. 无需手动复制凭据.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
                <div>
                    <Button type="button" variant="primary" size="lg" disabled={connecting} onClick={connect}>
                        {connecting ? "正在跳转 GitHub..." : "连接 GitHub 账号"}
                    </Button>
                </div>
                {app.state === "error" ? (
                    <Alert variant="danger">
                        <AlertTitle>读取连接状态失败</AlertTitle>
                        <AlertDescription>{app.message}</AlertDescription>
                    </Alert>
                ) : null}
                {connectError ? (
                    <Alert variant={connectError === NOT_READY ? "warning" : "danger"}>
                        <AlertTitle>{connectError === NOT_READY ? "后端未就绪" : "无法发起连接"}</AlertTitle>
                        <AlertDescription>{connectError}</AlertDescription>
                    </Alert>
                ) : null}
            </CardContent>
        </Card>
    );
}

function InstallSection({
    slug,
    installs,
    load,
}: {
    slug: string;
    installs: Load<GitHubInstallation[]>;
    load: () => void;
}) {
    const [picked, setPicked] = useState<number | null>(null);
    const installUrl = slug ? githubConnectApi.installUrl(slug) : null;

    const header = (
        <CardHeader className="flex flex-row flex-wrap items-center gap-2">
            <CardTitle>安装与仓库</CardTitle>
            <span className="ml-auto flex items-center gap-2">
                {installUrl && installs.state === "ready" && installs.value.length > 0 ? (
                    <a href={installUrl} target="_blank" rel="noreferrer" className="text-[length:var(--fs-xs)]">
                        在 GitHub 上添加更多仓库
                    </a>
                ) : null}
                <Button type="button" variant="ghost" size="xs" onClick={load}>
                    刷新
                </Button>
            </span>
        </CardHeader>
    );

    if (installs.state !== "ready") {
        return (
            <Card>
                {header}
                <CardContent>
                    {installs.state === "loading" ? (
                        <EmptyState kind="loading" text="读取安装列表..." compact />
                    ) : installs.state === "notReady" ? (
                        <EmptyState kind="empty" text="后端未就绪" hint={NOT_READY} compact />
                    ) : (
                        <EmptyState kind="error" text="读取安装列表失败" hint={installs.message} compact />
                    )}
                </CardContent>
            </Card>
        );
    }

    const list = installs.value;
    if (list.length === 0) {
        return (
            <Card>
                {header}
                <CardContent className="flex flex-col gap-2 text-[length:var(--fs-xs)]">
                    <span>App 还没有安装到任何账号. 安装时选择要审查的仓库, 完成后回到本页点刷新.</span>
                    <div>
                        {installUrl ? (
                            <Button asChild variant="primary">
                                <a href={installUrl} target="_blank" rel="noreferrer">
                                    在 GitHub 上安装 App
                                </a>
                            </Button>
                        ) : (
                            <span className="text-muted-foreground">缺少 App slug, 请在高级配置中补全.</span>
                        )}
                    </div>
                </CardContent>
            </Card>
        );
    }

    const current = list.find((item) => item.installationId === picked) ?? list[0];
    const label = (item: GitHubInstallation) =>
        item.account + (item.accountType ? " (" + item.accountType + ")" : "") + (item.suspended ? " 已暂停" : "");
    return (
        <Card>
            {header}
            <CardContent className="flex flex-col gap-2 px-0 pb-0">
                <div className="flex flex-wrap items-center gap-2 px-4 text-[length:var(--fs-xs)]">
                    <span>安装</span>
                    {list.length > 1 ? (
                        <MotionSelect
                            value={String(current.installationId)}
                            onValueChange={(value) => setPicked(Number(value))}
                            options={list.map((item) => ({ value: String(item.installationId), label: label(item) }))}
                            aria-label="选择安装"
                        />
                    ) : (
                        <span className="font-mono">{label(current)}</span>
                    )}
                </div>
                <GitHubRepos key={current.installationId} installationId={current.installationId} />
            </CardContent>
        </Card>
    );
}

/** For people who do not want the App: copy the caller workflow and set one secret and one variable. */
function ManualIntake() {
    return (
        <Card>
            <CardHeader>
                <CardTitle>手动接入 (不安装 App)</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1 text-[length:var(--fs-xs)]">
                <span>
                    把 {MANUAL_SOURCE} 的 <span className="font-mono">{MANUAL_TEMPLATE}</span> 复制到你仓库的{" "}
                    <span className="font-mono">{MANUAL_TARGET}</span>:
                </span>
                <CopyField value={`${MANUAL_SOURCE}/${MANUAL_TEMPLATE} -> ${MANUAL_TARGET}`} label="手动接入路径" />
                <span>
                    再在仓库设置中配置 secret <span className="font-mono">HX_CTX_TOKEN</span> 与变量{" "}
                    <span className="font-mono">HX_CTX_ENDPOINT</span>.
                </span>
            </CardContent>
        </Card>
    );
}

/** GitHub page: connect the account, install the App, enable repos one click each; hand-filled config is advanced. */
export function GitHubApp() {
    const [app, setApp] = useState<Load<GitHubAppInfo>>({ state: "loading" });
    const [installs, setInstalls] = useState<Load<GitHubInstallation[]>>({ state: "loading" });
    const [callback, setCallback] = useState<Callback | null>(() => {
        const taken = pendingCallback ?? takeCallback();
        pendingCallback = null;
        return taken;
    });

    const load = useCallback(() => {
        setApp({ state: "loading" });
        setInstalls({ state: "loading" });
        settle(githubApi.getApp(), setApp);
        settle(
            githubApi.installations().then((value) => value.installations),
            setInstalls,
        );
    }, []);

    useEffect(load, [load]);

    const view = app.state === "ready" ? app.value.app : null;
    const connected = app.state === "ready" && (app.value.configured || view !== null);
    const installCount = installs.state === "ready" ? installs.value.length : null;

    return (
        <div className="flex flex-col gap-3">
            {callback ? <CallbackBanner callback={callback} onClose={() => setCallback(null)} /> : null}
            <ConnectCard app={app} installCount={installCount} />
            {connected ? <InstallSection slug={view?.slug ?? ""} installs={installs} load={load} /> : null}
            <ManualIntake />
            <details className="rounded-md border border-border">
                <summary className="cursor-pointer px-4 py-2 text-[length:var(--fs-xs)]">
                    高级: 手动配置 (自建 App 并粘贴凭据)
                </summary>
                <div className="p-3">
                    <ManualConfig app={app} installs={installs} load={load} />
                </div>
            </details>
        </div>
    );
}
