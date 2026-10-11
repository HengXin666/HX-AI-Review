import { useState } from "react";
import type { FormEvent } from "react";
import type { Provider, ProviderInput } from "../api.ts";
import { box, cell, table } from "./style.ts";

const HEADERS = [
    "Name",
    "api_url",
    "API",
    "Key secret",
    "USD per 1M: in / out / cache r / cache w",
    "Context / max out",
];
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SECRET = /^[A-Z][A-Z0-9_]{0,63}$/;
const NUMBERS = [
    ["priceInput", "in $/1M", true],
    ["priceOutput", "out $/1M", true],
    ["priceCacheRead", "cache read $/1M", false],
    ["priceCacheWrite", "cache write $/1M", false],
    ["contextWindow", "context 128000", false],
    ["maxTokens", "max out 8192", false],
] as const;

type Parsed = { name: string; input: Partial<ProviderInput> } | { error: string };

/**
 * Invalid numbers are an error, never a silent 0: a zero price disables budgets. Empty optional fields
 * are left out so the Worker keeps the stored value (or its default for a new provider).
 */
function readForm(form: HTMLFormElement, known: Provider[]): Parsed {
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const name = text("name");
    const exists = known.some((item) => item.name === name);
    if (!NAME.test(name)) {
        return { error: "name: letters, digits, '.', '_' or '-' only" };
    }
    const input: Partial<ProviderInput> = {
        api: text("api") === "anthropic-messages" ? "anthropic-messages" : "openai-completions",
    };
    if (text("apiUrl")) {
        input.apiUrl = text("apiUrl");
    }
    if (text("keySecret")) {
        if (!SECRET.test(text("keySecret"))) {
            return { error: "key secret: an upper-case Worker secret name such as PROVIDER_DEFAULT_KEY" };
        }
        input.keySecret = text("keySecret");
    }
    if (!exists && (!input.apiUrl || !input.keySecret)) {
        return { error: "a new provider needs api_url and a key secret name" };
    }
    for (const [key, label, required] of NUMBERS) {
        const raw = text(key);
        if (raw === "") {
            if (required && !exists) {
                return { error: `${label}: required for a new provider (0 if free)` };
            }
            continue;
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) {
            return { error: `${label}: must be a non-negative number` };
        }
        input[key] = value;
    }
    return { name, input };
}

type Props = { providers: Provider[]; onSave: (name: string, input: Partial<ProviderInput>) => void };

/** Model providers. The key itself is a Worker secret set by the deploy workflow; only its presence shows. */
export function Providers({ providers, onSave }: Props) {
    const [error, setError] = useState<string | null>(null);
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const parsed = readForm(event.currentTarget, providers);
        if ("error" in parsed) {
            setError(parsed.error);
            return;
        }
        setError(null);
        onSave(parsed.name, parsed.input);
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
                                {item.priceInput} / {item.priceOutput} / {item.priceCacheRead} / {item.priceCacheWrite}
                            </td>
                            <td style={cell}>
                                {item.contextWindow} / {item.maxTokens}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <form onSubmit={submit} style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <input name="name" placeholder="name, e.g. default" required />
                <input name="apiUrl" placeholder="https://api.example.com/v1" size={32} />
                <select name="api" defaultValue="openai-completions">
                    <option value="openai-completions">openai-completions</option>
                    <option value="anthropic-messages">anthropic-messages</option>
                </select>
                <input name="keySecret" placeholder="PROVIDER_DEFAULT_KEY" />
                {NUMBERS.map(([key, label]) => (
                    <input key={key} name={key} placeholder={label} size={12} inputMode="decimal" />
                ))}
                <button type="submit">save provider</button>
            </form>
            <p style={{ color: "#666" }}>Empty optional fields keep the stored value when updating.</p>
            {error ? <p style={{ color: "crimson" }}>{error}</p> : null}
        </section>
    );
}
