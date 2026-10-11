import { useCallback, useEffect, useState } from "react";
import { api, patchBranchUrl } from "./api.ts";
import type { Finding, Overview, Repo } from "./api.ts";

const cell = { padding: "4px 8px", borderBottom: "1px solid #ddd", textAlign: "left" as const };

function RepoRow({ repo, onChange }: { repo: Repo; onChange: (patch: Partial<Repo>) => void }) {
    return (
        <tr>
            <td style={cell}>{repo.name}</td>
            <td style={cell}>
                <input
                    type="checkbox"
                    checked={repo.enabled}
                    onChange={(event) => onChange({ enabled: event.target.checked })}
                />
            </td>
            <td style={cell}>
                <select value={repo.mode} onChange={(event) => onChange({ mode: event.target.value as Repo["mode"] })}>
                    <option value="full">full</option>
                    <option value="l0">l0</option>
                </select>
            </td>
            <td style={cell}>
                {repo.finderModel} / {repo.verifierModel}
            </td>
            <td style={cell}>
                {repo.spentUsd.toFixed(2)} /{" "}
                <input
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={repo.budgetUsd}
                    style={{ width: 70 }}
                    onBlur={(event) => onChange({ budgetUsd: Number(event.target.value) })}
                />{" "}
                USD
            </td>
            <td style={cell}>{repo.lastSha?.slice(0, 10) ?? "-"}</td>
        </tr>
    );
}

function FindingRow({
    finding,
    onVerdict,
}: {
    finding: Finding;
    onVerdict: (verdict: "accepted" | "rejected") => void;
}) {
    return (
        <tr>
            <td style={cell}>{finding.repo}</td>
            <td style={cell}>
                {finding.severity} {finding.ruleId}
            </td>
            <td style={cell}>
                {finding.path}:{finding.line}
            </td>
            <td style={cell}>{finding.message}</td>
            <td style={cell}>
                {finding.patchKey ? (
                    <a href={`/api/findings/${finding.id}/patch`} target="_blank" rel="noreferrer">
                        patch
                    </a>
                ) : (
                    "-"
                )}
            </td>
            <td style={cell}>
                <button onClick={() => onVerdict("accepted")}>accept</button>{" "}
                <button onClick={() => onVerdict("rejected")}>reject</button>
            </td>
        </tr>
    );
}

export function App() {
    const [data, setData] = useState<Overview | null>(null);
    const [error, setError] = useState<string | null>(null);
    const reload = useCallback(() => {
        api.overview().then(setData, (err: Error) => setError(err.message));
    }, []);
    useEffect(reload, [reload]);

    const updateRepo = (name: string, patch: Partial<Repo>) => {
        api.updateRepo(name, patch).then(reload, (err: Error) => setError(err.message));
    };
    const verdict = (id: string, value: "accepted" | "rejected") => {
        // The reason flows back into the suppression table that the next /init sends to the finder.
        const reason = value === "rejected" ? window.prompt("Reject reason (sent to future reviews)") : "";
        if (value === "rejected" && !reason) {
            return;
        }
        api.feedback(id, value, reason ?? "").then(reload, (err: Error) => setError(err.message));
    };

    if (error) {
        return <p style={{ color: "crimson" }}>Error: {error}</p>;
    }
    if (!data) {
        return <p>Loading...</p>;
    }
    return (
        <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
            <h1>hx-context-review</h1>
            <h2>Repositories ({data.month})</h2>
            <table style={{ borderCollapse: "collapse" }}>
                <thead>
                    <tr>
                        {["Repo", "Enabled", "Mode", "Finder / verifier", "Budget", "last_sha"].map((title) => (
                            <th key={title} style={cell}>
                                {title}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {data.repos.map((repo) => (
                        <RepoRow key={repo.name} repo={repo} onChange={(patch) => updateRepo(repo.name, patch)} />
                    ))}
                </tbody>
            </table>
            <h2>Pending findings</h2>
            <table style={{ borderCollapse: "collapse" }}>
                <tbody>
                    {data.findings.map((finding) => (
                        <FindingRow
                            key={finding.id}
                            finding={finding}
                            onVerdict={(value) => verdict(finding.id, value)}
                        />
                    ))}
                </tbody>
            </table>
            <h2>Recent runs</h2>
            <ul>
                {data.runs.map((run) => (
                    <li key={run.id} id={"runs/" + run.id}>
                        {run.repo} {run.sha.slice(0, 10)} {run.event}
                        {run.prNumber ? ` #${run.prNumber}` : ""}: {run.status}, {run.errors}E/{run.warnings}W,{" "}
                        {run.costUsd.toFixed(3)} USD, {Math.round(run.durationMs / 1000)}s{" "}
                        {run.patchBranch ? (
                            <a href={patchBranchUrl(run.repo, run.patchBranch)} target="_blank" rel="noreferrer">
                                merge patch
                            </a>
                        ) : null}
                    </li>
                ))}
            </ul>
        </main>
    );
}
