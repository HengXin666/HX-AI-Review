import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle, Button, DataBoundary, EmptyState } from "@hx/ui";
import { ApiError, api } from "./api.ts";
import type { Overview, ProviderInput, Repo, RepoInput, RuleStats } from "./api.ts";
import { totals } from "./kind.ts";
import type { KindFilter } from "./kind.ts";
import { navEntries, Shell } from "./shell.tsx";
import type { SectionId } from "./shell.tsx";
import { Deployment } from "./sections/Deployment.tsx";
import { Findings } from "./sections/Findings.tsx";
import { Login } from "./sections/Login.tsx";
import { Overview as OverviewScreen } from "./sections/Overview.tsx";
import { Prompts } from "./sections/Prompts.tsx";
import { Providers } from "./sections/Providers.tsx";
import { Repos } from "./sections/Repos.tsx";
import { Rules } from "./sections/Rules.tsx";
import { Runs } from "./sections/Runs.tsx";

const SECTIONS: SectionId[] = ["overview", "runs", "findings", "repos", "providers", "rules", "prompts", "deploy"];

/** The screen named in the URL hash, so a section can be linked and survives a reload. */
function sectionFromHash(): SectionId {
    const id = window.location.hash.replace(/^#\/?/, "");
    return (SECTIONS as string[]).includes(id) ? (id as SectionId) : "overview";
}

/** 403 means the session cookie is gone or was never valid: the login screen is the only useful view. */
function isUnauthenticated(error: unknown): boolean {
    return error instanceof ApiError && error.status === 403;
}

export function App() {
    const [data, setData] = useState<Overview | null>(null);
    const [rules, setRules] = useState<RuleStats | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [phase, setPhase] = useState<"loading" | "login" | "ready">("loading");
    const [section, setSection] = useState<SectionId>(sectionFromHash);
    const [filter, setFilter] = useState<KindFilter>("all");

    const fail = useCallback((err: Error) => {
        setError(err.message);
        setLoading(false);
        if (isUnauthenticated(err)) {
            setPhase("login");
            setData(null);
        }
    }, []);

    const reload = useCallback(() => {
        setLoading(true);
        api.overview().then((next) => {
            setError(null);
            setData(next);
            setLoading(false);
            setPhase("ready");
        }, fail);
        api.rules().then(setRules, () => setRules(null));
    }, [fail]);

    useEffect(reload, [reload]);

    // The hash is the only navigation state, so the back button and a shared link both work.
    useEffect(() => {
        const sync = () => setSection(sectionFromHash());
        window.addEventListener("hashchange", sync);
        return () => window.removeEventListener("hashchange", sync);
    }, []);

    const go = (id: SectionId) => {
        setSection(id);
        window.location.hash = "/" + id;
    };

    const updateRepo = (name: string, patch: Partial<Repo>) => {
        api.updateRepo(name, patch).then(reload, fail);
    };
    const createRepo = async (input: RepoInput) => {
        try {
            const { token } = await api.createRepo(input);
            reload();
            return token;
        } catch (err) {
            fail(err as Error);
            return null;
        }
    };
    const rotate = async (name: string) => {
        try {
            return (await api.rotateToken(name)).token;
        } catch (err) {
            fail(err as Error);
            return null;
        }
    };
    const saveProvider = (name: string, input: Partial<ProviderInput>) => {
        api.saveProvider(name, input).then(reload, fail);
    };
    const verdict = (id: string, value: "accepted" | "rejected", reason: string) => {
        if (value === "rejected" && !reason.trim()) {
            setError("驳回需要填写原因");
            return;
        }
        api.feedback(id, value, reason).then(reload, fail);
    };
    const logout = () => {
        api.logout().then(() => {
            setData(null);
            setPhase("login");
        }, fail);
    };

    if (phase === "login") {
        return (
            <Login
                error={error}
                onSubmit={(user, password) => {
                    api.login(user, password).then(reload, fail);
                }}
            />
        );
    }
    if (!data) {
        return (
            <div className="grid min-h-screen place-items-center bg-background p-6">
                <div className="w-full max-w-md">
                    {error ? (
                        <EmptyState
                            kind="error"
                            text="加载失败"
                            hint={error}
                            action={
                                <Button type="button" variant="outline" size="sm" onClick={reload}>
                                    重试
                                </Button>
                            }
                        />
                    ) : (
                        <EmptyState kind="loading" text="加载中..." />
                    )}
                </div>
            </div>
        );
    }

    const entries = navEntries(totals(data, "all").open);
    const screen = (id: SectionId) => {
        switch (id) {
            case "overview":
                return <OverviewScreen data={data} filter={filter} onSection={go} onVerdict={verdict} />;
            case "runs":
                return <Runs runs={data.runs} filter={filter} />;
            case "findings":
                return (
                    <Findings
                        findings={data.findings}
                        resolved={data.resolved ?? []}
                        filter={filter}
                        onVerdict={verdict}
                    />
                );
            case "repos":
                return <Repos repos={data.repos} onChange={updateRepo} onCreate={createRepo} onRotate={rotate} />;
            case "providers":
                return <Providers providers={data.providers} onSave={saveProvider} />;
            case "rules":
                return <Rules stats={rules} filter={filter} />;
            case "prompts":
                return <Prompts prompts={data.prompts ?? []} notes={data.notes ?? []} onDone={reload} onError={fail} />;
            case "deploy":
                return <Deployment info={data.deployment} />;
        }
    };

    return (
        <Shell
            data={data}
            entries={entries}
            section={section}
            filter={filter}
            onFilter={setFilter}
            onSection={go}
            onLogout={logout}
        >
            {error ? (
                <Alert variant="danger">
                    <AlertTitle>操作失败</AlertTitle>
                    <AlertDescription className="flex items-center gap-2">
                        <span className="min-w-0 flex-1">{error}</span>
                        <Button type="button" variant="outline" size="xs" onClick={reload}>
                            重试
                        </Button>
                        <Button type="button" variant="ghost" size="xs" onClick={() => setError(null)}>
                            关闭
                        </Button>
                    </AlertDescription>
                </Alert>
            ) : null}
            <DataBoundary loading={loading && !data} error={null} loadingText="加载中...">
                {screen(section)}
            </DataBoundary>
            <p className="mt-auto text-[length:var(--fs-2xs)] text-muted-foreground">
                上下文 CR 与代码 CR 共用同一份预算, 模型供应商与驳回抑制表; 错误只来自 L0 确定性检查。
            </p>
        </Shell>
    );
}
