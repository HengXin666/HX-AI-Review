import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from "@hx/ui";
import { ApiError, api } from "../api.ts";
import type { GithubAppView } from "../api.ts";

/** Submit GitHub's manifest form in the browser. A fetch cannot navigate the user to github.com. */
function postManifest(action: string, manifest: Record<string, unknown>) {
    const form = document.createElement("form");
    form.method = "post";
    form.action = action;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "manifest";
    input.value = JSON.stringify(manifest);
    form.append(input);
    document.body.append(form);
    form.submit();
}

export function GithubApp() {
    const [view, setView] = useState<GithubAppView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = () => {
        api.githubApp().then(
            (next) => {
                setView(next);
                setError(null);
            },
            (err: Error) => setError(err.message),
        );
    };
    useEffect(load, []);

    const create = (org: string) => {
        setBusy(true);
        api.githubManifest(org || undefined).then(
            (started) => postManifest(started.action, started.manifest),
            (err: Error) => {
                setBusy(false);
                setError(err instanceof ApiError ? err.message : err.message);
            },
        );
    };

    const save = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const appId = Number(String(data.get("appId") ?? ""));
        setBusy(true);
        api.saveGithubApp({
            appId,
            slug: String(data.get("slug") ?? "").trim(),
            name: String(data.get("name") ?? "").trim() || undefined,
            privateKey: String(data.get("privateKey") ?? ""),
            webhookSecret: String(data.get("webhookSecret") ?? ""),
        }).then(
            () => {
                setBusy(false);
                event.currentTarget.reset();
                load();
            },
            (err: Error) => {
                setBusy(false);
                setError(err.message);
            },
        );
    };

    return (
        <div className="grid gap-4">
            {error ? (
                <Alert variant="danger">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            ) : null}
            <Card>
                <CardHeader>
                    <CardTitle>当前 App</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm">
                    {!view ? (
                        <p>加载中...</p>
                    ) : view.configured ? (
                        <>
                            <p>
                                <Badge variant="success">{view.bot}</Badge>
                                <span className="ml-2">
                                    {view.name} · App ID {view.appId}
                                </span>
                            </p>
                            <p className="text-muted-foreground">
                                私钥已保存在后端，这里不再显示。业务仓库不用再填 GH_APP_TOKEN。
                            </p>
                            {view.installUrl ? (
                                <p>
                                    <a className="underline" href={view.installUrl} target="_blank" rel="noreferrer">
                                        把这个 App 安装到仓库
                                    </a>
                                </p>
                            ) : null}
                        </>
                    ) : (
                        <p>还没有登记。创建之后，审查评论会显示成这个 App，而不是 github-actions[bot]。</p>
                    )}
                    {view?.webhookUrl ? (
                        <p className="break-all font-mono text-xs text-muted-foreground">Webhook {view.webhookUrl}</p>
                    ) : null}
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>在 GitHub 上创建</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3">
                    <p className="text-sm text-muted-foreground">
                        会跳到 GitHub，由你确认一次 App 名称和权限。确认后私钥自动回到后端，不用复制 PEM。
                    </p>
                    <form
                        className="flex flex-wrap items-end gap-2"
                        onSubmit={(event) => {
                            event.preventDefault();
                            const org = String(new FormData(event.currentTarget).get("org") ?? "").trim();
                            create(org);
                        }}
                    >
                        <label className="grid gap-1 text-sm">
                            组织（个人账号留空）
                            <Input name="org" placeholder="my-org" autoComplete="off" />
                        </label>
                        <Button type="submit" disabled={busy}>
                            创建 GitHub App
                        </Button>
                    </form>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>或粘贴已有 App</CardTitle>
                </CardHeader>
                <CardContent>
                    <form className="grid gap-3" onSubmit={save}>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="grid gap-1 text-sm">
                                App ID
                                <Input name="appId" inputMode="numeric" required />
                            </label>
                            <label className="grid gap-1 text-sm">
                                slug
                                <Input name="slug" placeholder="hx-ai-review" required />
                            </label>
                        </div>
                        <label className="grid gap-1 text-sm">
                            私钥 PEM
                            <textarea
                                name="privateKey"
                                required
                                className="min-h-28 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
                            />
                        </label>
                        <label className="grid gap-1 text-sm">
                            Webhook secret
                            <Input name="webhookSecret" type="password" required autoComplete="off" />
                        </label>
                        <Button type="submit" variant="outline" disabled={busy}>
                            保存到后端
                        </Button>
                    </form>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>已安装</CardTitle>
                </CardHeader>
                <CardContent className="text-sm">
                    {view && view.installations.length > 0 ? (
                        <ul className="grid gap-2">
                            {view.installations.map((item) => (
                                <li key={item.installationId}>
                                    <span className="font-medium">{item.accountLogin}</span>
                                    {item.suspended ? "（已暂停）" : ""}
                                    {" · "}
                                    {item.allRepos ? "全部仓库" : item.repos.join(", ") || "还没有仓库"}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-muted-foreground">还没有安装记录。安装 App 之后，GitHub 会回调 webhook。</p>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
