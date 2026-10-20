import { useCallback, useEffect, useState } from "react";
import { Button, PageHeader } from "@hx/ui";
import { ApiError, api } from "./api.ts";
import type { Overview, ProviderInput, Repo, RepoInput, RuleStats } from "./api.ts";
import { Activity } from "./sections/Activity.tsx";
import { Deployment } from "./sections/Deployment.tsx";
import { Login } from "./sections/Login.tsx";
import { Prompts } from "./sections/Prompts.tsx";
import { Providers } from "./sections/Providers.tsx";
import { Repos } from "./sections/Repos.tsx";
import { Rules } from "./sections/Rules.tsx";

export function App() {
    const [data, setData] = useState<Overview | null>(null);
    const [rules, setRules] = useState<RuleStats | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [phase, setPhase] = useState<"loading" | "login" | "ready">("loading");
    const fail = (err: Error) => {
        setError(err.message);
        if (err instanceof ApiError && err.status === 403) {
            setPhase("login");
            setData(null);
        }
    };
    const reload = useCallback(() => {
        api.overview().then(
            (next) => {
                setError(null);
                setData(next);
                setPhase("ready");
            },
            fail,
        );
        api.rules().then(setRules, () => setRules(null));
    }, []);
    useEffect(reload, [reload]);

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
            setError("a rejection needs a reason");
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
        return <Login error={error} onSubmit={(user, password) => api.login(user, password).then(reload, fail)} />;
    }
    if (!data) {
        return <p className="p-6 text-sm text-muted-foreground">{error ? `Error: ${error}` : "Loading..."}</p>;
    }
    return (
        <main className="mx-auto max-w-6xl p-6 text-foreground">
            <PageHeader
                title="hx-context-review"
                desc={`Budgets and spend are for ${data.month}; 0 means no monthly cap.`}
                right={
                    <Button type="button" variant="outline" onClick={logout}>
                        log out
                    </Button>
                }
            />
            {error ? (
                <p className="mb-4 text-sm text-danger-fg">
                    Error: {error}{" "}
                    <Button type="button" variant="ghost" onClick={reload}>
                        retry
                    </Button>
                </p>
            ) : null}
            <Deployment info={data.deployment} />
            <Repos repos={data.repos} onChange={updateRepo} onCreate={createRepo} onRotate={rotate} />
            <Providers providers={data.providers} onSave={saveProvider} />
            <Prompts prompts={data.prompts ?? []} notes={data.notes ?? []} onDone={reload} onError={fail} />
            <Rules stats={rules} />
            <Activity findings={data.findings} resolved={data.resolved ?? []} runs={data.runs} onVerdict={verdict} />
        </main>
    );
}
