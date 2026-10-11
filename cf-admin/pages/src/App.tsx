import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import type { Overview, ProviderInput, Repo, RepoInput } from "./api.ts";
import { Activity } from "./sections/Activity.tsx";
import { Deployment } from "./sections/Deployment.tsx";
import { Providers } from "./sections/Providers.tsx";
import { Repos } from "./sections/Repos.tsx";

export function App() {
    const [data, setData] = useState<Overview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const fail = (err: Error) => setError(err.message);
    const reload = useCallback(() => {
        api.overview().then((next) => {
            setError(null);
            setData(next);
        }, fail);
    }, []);
    useEffect(reload, [reload]);

    const updateRepo = (name: string, patch: Partial<Repo>) => {
        api.updateRepo(name, patch).then(reload, fail);
    };
    // Token calls report failures through the page error and return null so nothing shows as a token.
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
    const verdict = (id: string, value: "accepted" | "rejected") => {
        // The reason flows back into the suppression table that the next /init sends to the finder.
        const reason = value === "rejected" ? window.prompt("Reject reason (sent to future reviews)") : "";
        if (value === "rejected" && !reason) {
            return;
        }
        api.feedback(id, value, reason ?? "").then(reload, fail);
    };

    if (!data) {
        return error ? <p style={{ color: "crimson" }}>Error: {error}</p> : <p>Loading...</p>;
    }
    return (
        <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 1200 }}>
            <h1>hx-context-review</h1>
            {error ? (
                <p style={{ color: "crimson" }}>
                    Error: {error} <button onClick={reload}>retry</button>
                </p>
            ) : null}
            <Deployment info={data.deployment} />
            <Repos repos={data.repos} onChange={updateRepo} onCreate={createRepo} onRotate={rotate} />
            <Providers providers={data.providers} onSave={saveProvider} />
            <Activity findings={data.findings} runs={data.runs} onVerdict={verdict} />
            <p style={{ color: "#666" }}>Budgets and spend are for {data.month}; 0 means no monthly cap.</p>
        </main>
    );
}
