import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@hx/ui";
import { useState } from "react";
import type { FormEvent } from "react";
import type { Provider, ProviderInput } from "../api.ts";

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
    const input: Partial<ProviderInput> = {};
    // Empty select = keep the stored protocol on update (the Worker defaults a new provider to openai-completions).
    const api = text("api");
    if (api === "openai-completions" || api === "anthropic-messages") {
        input.api = api;
    }
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
        const integer = key === "contextWindow" || key === "maxTokens";
        if (integer ? !Number.isSafeInteger(value) || value < 1 : !Number.isFinite(value) || value < 0) {
            return { error: `${label}: must be ${integer ? "a positive integer" : "a non-negative number"}` };
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
        <Card className="my-4">
            <CardHeader>
                <CardTitle>Model providers</CardTitle>
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
                        {providers.map((item) => (
                            <tr key={item.name}>
                                <td className="border-b border-border px-2 py-1">{item.name}</td>
                                <td className="border-b border-border px-2 py-1">{item.apiUrl}</td>
                                <td className="border-b border-border px-2 py-1">{item.api}</td>
                                <td className="border-b border-border px-2 py-1">
                                    {item.keySecret} {item.keyPresent ? "(set)" : <strong>(missing)</strong>}
                                </td>
                                <td className="border-b border-border px-2 py-1">
                                    {item.priceInput} / {item.priceOutput} / {item.priceCacheRead} /{" "}
                                    {item.priceCacheWrite}
                                </td>
                                <td className="border-b border-border px-2 py-1">
                                    {item.contextWindow} / {item.maxTokens}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
                    <Input name="name" placeholder="name, e.g. default" required className="w-40" />
                    <Input name="apiUrl" placeholder="https://api.example.com/v1" className="w-64" />
                    <select
                        name="api"
                        defaultValue=""
                        className="h-8 rounded-lg border border-border bg-transparent px-2 text-sm"
                    >
                        <option value="">API: keep (new: openai-completions)</option>
                        <option value="openai-completions">openai-completions</option>
                        <option value="anthropic-messages">anthropic-messages</option>
                    </select>
                    <Input name="keySecret" placeholder="PROVIDER_DEFAULT_KEY" className="w-52" />
                    {NUMBERS.map(([key, label]) => (
                        <Input key={key} name={key} placeholder={label} className="w-36" inputMode="decimal" />
                    ))}
                    <Button type="submit" variant="primary">
                        save provider
                    </Button>
                </form>
                <p className="mt-2 text-xs text-muted-foreground">
                    Empty optional fields keep the stored value when updating.
                </p>
                {error ? <p className="text-sm text-danger-fg">{error}</p> : null}
            </CardContent>
        </Card>
    );
}
