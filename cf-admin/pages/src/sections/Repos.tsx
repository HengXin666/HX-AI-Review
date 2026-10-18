import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@hx/ui";
import { useState } from "react";
import type { FocusEvent, FormEvent } from "react";
import type { Repo, RepoInput } from "../api.ts";

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
    const [error, setError] = useState<string | null>(null);
    const create = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (key: string) => String(data.get(key) ?? "").trim();
        // Only an explicitly empty budget means "no cap"; anything invalid is rejected, never turned into 0.
        const rawBudget = text("budgetUsd");
        const budget = rawBudget === "" ? 0 : Number(rawBudget);
        if (!Number.isFinite(budget) || budget < 0) {
            setError("monthly budget must be a non-negative number, or empty for no cap");
            return;
        }
        setError(null);
        const input: RepoInput = {
            name: text("name"),
            provider: text("provider") || "default",
            finderModel: text("finderModel"),
            verifierModel: text("verifierModel"),
            budgetUsd: budget,
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
        <Card className="my-4">
            <CardHeader>
                <CardTitle>Repositories</CardTitle>
            </CardHeader>
            <CardContent className="pb-4">
                <table className="w-full border-collapse text-left text-sm">
                    <thead>
                        <tr>
                            {HEADERS.map((title) => (
                                <th key={title} className="border-b border-border px-2 py-1">
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
                                    <td className="border-b border-border px-2 py-1">{repo.name}</td>
                                    <td className="border-b border-border px-2 py-1">
                                        <input
                                            type="checkbox"
                                            checked={repo.enabled}
                                            onChange={(event) => change({ enabled: event.target.checked })}
                                        />
                                    </td>
                                    <td className="border-b border-border px-2 py-1">
                                        <select
                                            value={repo.mode}
                                            onChange={(event) => change({ mode: event.target.value as Repo["mode"] })}
                                        >
                                            <option value="full">full</option>
                                            <option value="l0">l0</option>
                                        </select>
                                    </td>
                                    <td className="border-b border-border px-2 py-1">
                                        {repo.finderModel} / {repo.verifierModel}
                                    </td>
                                    <td className="border-b border-border px-2 py-1">
                                        {repo.spentUsd.toFixed(2)} /{" "}
                                        <input
                                            type="number"
                                            min={0}
                                            step={1}
                                            defaultValue={repo.budgetUsd}
                                            className="w-20 rounded-lg border border-border bg-transparent px-2"
                                            onBlur={budgetBlur(repo, change)}
                                        />{" "}
                                        USD
                                    </td>
                                    <td className="border-b border-border px-2 py-1">
                                        {repo.lastSha?.slice(0, 10) ?? "-"}
                                    </td>
                                    <td className="border-b border-border px-2 py-1">
                                        <Button type="button" variant="outline" onClick={() => rotate(repo.name)}>
                                            rotate
                                        </Button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
                <form onSubmit={create} className="mt-3 flex flex-wrap gap-2">
                    <Input name="name" placeholder="owner/repo" required className="w-40" />
                    <Input name="provider" placeholder="provider (default)" className="w-40" />
                    <Input name="finderModel" placeholder="finder model" required className="w-36" />
                    <Input name="verifierModel" placeholder="verifier model" required className="w-36" />
                    <Input name="budgetUsd" placeholder="budget USD (empty = no cap)" className="w-52" />
                    <Button type="submit" variant="primary">
                        register repo
                    </Button>
                </form>
                {error ? <p className="mt-2 text-sm text-danger-fg">{error}</p> : null}
                {token ? (
                    <p className="mt-2 text-sm">
                        HX_CTX_TOKEN for {token.repo}, shown once; save it as the repository secret now:{" "}
                        <code>{token.value}</code>
                    </p>
                ) : null}
            </CardContent>
        </Card>
    );
}
