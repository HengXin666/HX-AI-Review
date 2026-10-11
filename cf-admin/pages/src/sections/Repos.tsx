import { useState } from "react";
import type { FocusEvent, FormEvent } from "react";
import type { Repo, RepoInput } from "../api.ts";
import { box, cell, table } from "./style.ts";

const HEADERS = ["Repo", "Enabled", "Mode", "Finder / verifier", "Budget", "last_sha", "Token"];

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

type Props = {
    repos: Repo[];
    onChange: (name: string, patch: Partial<Repo>) => void;
    onCreate: (input: RepoInput) => Promise<string | null>;
    onRotate: (name: string) => Promise<string | null>;
};

export function Repos({ repos, onChange, onCreate, onRotate }: Props) {
    const [token, setToken] = useState<{ repo: string; value: string } | null>(null);
    const create = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (key: string) => String(data.get(key) ?? "").trim();
        const budget = Number(text("budgetUsd"));
        const input: RepoInput = {
            name: text("name"),
            provider: text("provider") || "default",
            finderModel: text("finderModel"),
            verifierModel: text("verifierModel"),
            budgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : 0,
        };
        const value = await onCreate(input);
        setToken(value ? { repo: input.name, value } : null);
    };
    const rotate = async (name: string) => {
        if (window.confirm(`Rotate HX_CTX_TOKEN for ${name}? The old token stops working.`)) {
            const value = await onRotate(name);
            setToken(value ? { repo: name, value } : null);
        }
    };
    return (
        <section style={box}>
            <h2>Repositories</h2>
            <table style={table}>
                <thead>
                    <tr>
                        {HEADERS.map((title) => (
                            <th key={title} style={cell}>
                                {title}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {repos.map((repo) => {
                        const change = (patch: Partial<Repo>) => onChange(repo.name, patch);
                        return (
                            <tr key={repo.name}>
                                <td style={cell}>{repo.name}</td>
                                <td style={cell}>
                                    <input
                                        type="checkbox"
                                        checked={repo.enabled}
                                        onChange={(event) => change({ enabled: event.target.checked })}
                                    />
                                </td>
                                <td style={cell}>
                                    <select
                                        value={repo.mode}
                                        onChange={(event) => change({ mode: event.target.value as Repo["mode"] })}
                                    >
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
                                        onBlur={budgetBlur(repo, change)}
                                    />{" "}
                                    USD
                                </td>
                                <td style={cell}>{repo.lastSha?.slice(0, 10) ?? "-"}</td>
                                <td style={cell}>
                                    <button onClick={() => rotate(repo.name)}>rotate</button>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            <form onSubmit={create} style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <input name="name" placeholder="owner/repo" required />
                <input name="provider" placeholder="provider (default)" />
                <input name="finderModel" placeholder="finder model" required />
                <input name="verifierModel" placeholder="verifier model" required />
                <input name="budgetUsd" placeholder="monthly budget USD" size={10} />
                <button type="submit">register repo</button>
            </form>
            {token ? (
                <p>
                    HX_CTX_TOKEN for {token.repo}, shown once; save it as the repository secret now:{" "}
                    <code>{token.value}</code>
                </p>
            ) : null}
        </section>
    );
}
