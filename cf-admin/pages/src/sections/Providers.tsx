import { useState } from "react";
import type { FormEvent } from "react";
import type { Provider, ProviderInput } from "../api.ts";
import { box, cell, table } from "./style.ts";

const HEADERS = ["Name", "api_url", "API", "Key secret", "Price in/out (USD per 1M)", "Context"];

function readForm(form: HTMLFormElement): { name: string; input: ProviderInput } {
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const number = (key: string, fallback: number) => {
        const value = Number(text(key));
        return text(key) !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
    };
    return {
        name: text("name"),
        input: {
            apiUrl: text("apiUrl"),
            api: text("api") === "anthropic-messages" ? "anthropic-messages" : "openai-completions",
            keySecret: text("keySecret"),
            contextWindow: number("contextWindow", 128000),
            maxTokens: number("maxTokens", 8192),
            priceInput: number("priceInput", 0),
            priceOutput: number("priceOutput", 0),
        },
    };
}

/** Model providers. The key itself is a Worker secret set by the deploy workflow; only its presence shows. */
export function Providers({
    providers,
    onSave,
}: {
    providers: Provider[];
    onSave: (name: string, input: ProviderInput) => void;
}) {
    const [error, setError] = useState<string | null>(null);
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const { name, input } = readForm(event.currentTarget);
        if (!name || !input.apiUrl || !input.keySecret) {
            setError("name, api_url and key secret name are required");
            return;
        }
        setError(null);
        onSave(name, input);
    };
    return (
        <section style={box}>
            <h2>Model providers</h2>
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
                    {providers.map((item) => (
                        <tr key={item.name}>
                            <td style={cell}>{item.name}</td>
                            <td style={cell}>{item.apiUrl}</td>
                            <td style={cell}>{item.api}</td>
                            <td style={cell}>
                                {item.keySecret} {item.keyPresent ? "(set)" : <strong>(missing)</strong>}
                            </td>
                            <td style={cell}>
                                {item.priceInput} / {item.priceOutput}
                            </td>
                            <td style={cell}>{item.contextWindow}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <form onSubmit={submit} style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <input name="name" placeholder="name (default)" />
                <input name="apiUrl" placeholder="https://api.example.com/v1" size={32} />
                <select name="api" defaultValue="openai-completions">
                    <option value="openai-completions">openai-completions</option>
                    <option value="anthropic-messages">anthropic-messages</option>
                </select>
                <input name="keySecret" placeholder="PROVIDER_DEFAULT_KEY" />
                <input name="priceInput" placeholder="in $/1M" size={8} />
                <input name="priceOutput" placeholder="out $/1M" size={8} />
                <input name="contextWindow" placeholder="128000" size={8} />
                <button type="submit">save provider</button>
            </form>
            {error ? <p style={{ color: "crimson" }}>{error}</p> : null}
        </section>
    );
}
