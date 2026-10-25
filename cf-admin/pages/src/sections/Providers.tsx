import { useState } from "react";
import type { FormEvent } from "react";
import {
    Alert,
    AlertDescription,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DataTable,
    Input,
    MotionSelect,
} from "@hx/ui";
import type { DataTableColumn } from "@hx/ui";
import type { Provider, ProviderInput } from "../api.ts";

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SECRET = /^[A-Z][A-Z0-9_]{0,63}$/;
const NUMBERS = [
    ["priceInput", "输入 $/1M", true],
    ["priceOutput", "输出 $/1M", true],
    ["priceCacheRead", "缓存读 $/1M", false],
    ["priceCacheWrite", "缓存写 $/1M", false],
    ["contextWindow", "上下文 128000", false],
    ["maxTokens", "最大输出 8192", false],
] as const;

type Parsed = { name: string; input: Partial<ProviderInput> } | { error: string };

/**
 * Invalid numbers are an error, never a silent 0: a zero price disables budgets. Empty optional fields
 * are left out so the Worker keeps the stored value (or its default for a new provider).
 */
const API_ITEMS = [
    { value: "keep", label: "协议: 保持 (新增为 openai-completions)" },
    { value: "openai-completions", label: "openai-completions" },
    { value: "anthropic-messages", label: "anthropic-messages" },
];

function readForm(form: HTMLFormElement, known: Provider[], api: string): Parsed {
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const name = text("name");
    const exists = known.some((item) => item.name === name);
    if (!NAME.test(name)) {
        return { error: "名称只能包含字母, 数字, '.', '_' 或 '-'" };
    }
    const input: Partial<ProviderInput> = {};
    // "keep" means leave the stored protocol alone on update (the Worker defaults a new provider).
    if (api === "openai-completions" || api === "anthropic-messages") {
        input.api = api;
    }
    if (text("apiUrl")) {
        input.apiUrl = text("apiUrl");
    }
    if (text("keySecret")) {
        if (!SECRET.test(text("keySecret"))) {
            return { error: "key secret 必须是全大写的 Worker secret 名, 例如 PROVIDER_DEFAULT_KEY" };
        }
        input.keySecret = text("keySecret");
    }
    if (!exists && (!input.apiUrl || !input.keySecret)) {
        return { error: "新增供应商必须填写 api_url 与 key secret 名" };
    }
    for (const [key, label, required] of NUMBERS) {
        const raw = text(key);
        if (raw === "") {
            if (required && !exists) {
                return { error: `${label}: 新增供应商必填 (免费填 0)` };
            }
            continue;
        }
        const value = Number(raw);
        const integer = key === "contextWindow" || key === "maxTokens";
        if (integer ? !Number.isSafeInteger(value) || value < 1 : !Number.isFinite(value) || value < 0) {
            return { error: `${label}: 必须是${integer ? "正整数" : "非负数"}` };
        }
        input[key] = value;
    }
    return { name, input };
}

type Props = { providers: Provider[]; onSave: (name: string, input: Partial<ProviderInput>) => void };

/** Model providers. The key itself is a Worker secret set by the deploy workflow; only its presence shows. */
export function Providers({ providers, onSave }: Props) {
    const [error, setError] = useState<string | null>(null);
    // Controlled because the select is a Radix widget: it does not submit a form field.
    const [api, setApi] = useState("keep");
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const parsed = readForm(event.currentTarget, providers, api);
        if ("error" in parsed) {
            setError(parsed.error);
            return;
        }
        setError(null);
        onSave(parsed.name, parsed.input);
    };

    const columns: DataTableColumn<Provider>[] = [
        { key: "name", header: "名称", width: "10rem" },
        {
            key: "apiUrl",
            header: "api_url",
            width: "16rem",
            render: (item) => <span className="truncate font-mono text-[length:var(--fs-2xs)]">{item.apiUrl}</span>,
        },
        { key: "api", header: "协议", width: "11rem" },
        {
            key: "keySecret",
            header: "Key secret",
            width: "16rem",
            render: (item) => (
                <span className="flex items-center gap-1.5">
                    <span className="font-mono text-[length:var(--fs-2xs)]">{item.keySecret}</span>
                    <Badge variant={item.keyPresent ? "success" : "destructive"}>
                        {item.keyPresent ? "已配置" : "缺失"}
                    </Badge>
                </span>
            ),
        },
        {
            key: "price",
            header: "单价 入 / 出 / 缓存读 / 缓存写",
            width: "16rem",
            numeric: true,
            render: (item) =>
                `${item.priceInput} / ${item.priceOutput} / ${item.priceCacheRead} / ${item.priceCacheWrite}`,
        },
        {
            key: "limits",
            header: "上下文 / 最大输出",
            width: "11rem",
            numeric: true,
            render: (item) => `${item.contextWindow} / ${item.maxTokens}`,
        },
    ];

    return (
        <Card>
            <CardHeader className="flex flex-row items-center gap-2">
                <CardTitle>模型供应商 ({providers.length})</CardTitle>
                <span className="ml-auto text-[length:var(--fs-2xs)] text-muted-foreground">
                    密钥本身是 Worker secret, 页面只显示是否已配置
                </span>
            </CardHeader>
            <CardContent className="px-0 pb-0">
                <DataTable
                    bare
                    rowKey={(item) => item.name}
                    rows={providers}
                    columns={columns}
                    emptyText="还没有供应商"
                />
            </CardContent>
            <CardContent className="flex flex-col gap-2 border-t border-border/50">
                <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
                    <Input name="name" placeholder="名称, 例如 default" required className="w-40" aria-label="名称" />
                    <Input
                        name="apiUrl"
                        placeholder="https://api.example.com/v1"
                        className="w-60"
                        aria-label="api_url"
                    />
                    <MotionSelect
                        aria-label="协议"
                        value={api}
                        onValueChange={setApi}
                        options={API_ITEMS}
                        triggerClassName="h-8 w-72 text-[length:var(--fs-xs)]"
                    />
                    <Input
                        name="keySecret"
                        placeholder="PROVIDER_DEFAULT_KEY"
                        className="w-52"
                        aria-label="key secret"
                    />
                    {NUMBERS.map(([key, label]) => (
                        <Input
                            key={key}
                            name={key}
                            placeholder={label}
                            className="w-36"
                            inputMode="decimal"
                            aria-label={label}
                        />
                    ))}
                    <Button type="submit" variant="primary">
                        保存供应商
                    </Button>
                </form>
                <p className="text-[length:var(--fs-2xs)] text-muted-foreground">
                    更新时留空的可选字段会保持原值; 非法数字会被拒绝。
                </p>
                {error ? (
                    <Alert variant="danger">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                ) : null}
            </CardContent>
        </Card>
    );
}
