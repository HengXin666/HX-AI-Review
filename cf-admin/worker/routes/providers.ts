import { HttpError, field, json, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import type { ProviderRow } from "../store/port.ts";

/** Provider names are plain identifiers, so the stored name always equals what repos reference. */
export const PROVIDER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

type Numeric = "contextWindow" | "maxTokens" | "priceInput" | "priceOutput" | "priceCacheRead" | "priceCacheWrite";

const DEFAULTS: Record<Numeric, number | undefined> = {
    contextWindow: 128000,
    maxTokens: 8192,
    // Prices have no default for a new provider: an omitted price would silently disable budgets.
    priceInput: undefined,
    priceOutput: undefined,
    priceCacheRead: 0,
    priceCacheWrite: 0,
};

/** Explicit value if valid, else the stored value on update, else the default; invalid input is a 400. */
function numeric(body: Record<string, unknown>, key: Numeric, existing: ProviderRow | null): number {
    const value = body[key];
    if (value !== undefined) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new HttpError(400, `${key} must be a non-negative number`);
        }
        return value;
    }
    const fallback = existing ? existing[key] : DEFAULTS[key];
    if (fallback === undefined) {
        throw new HttpError(400, `${key} is required for a new provider (USD per million tokens, 0 if free)`);
    }
    return fallback;
}

/** PUT /api/providers/{name}: create or update; omitted fields keep their stored values. */
export async function handleProviderPut(request: Request, deps: Deps, rawName: string): Promise<Response> {
    const name = decodeURIComponent(rawName);
    if (!PROVIDER_NAME.test(name)) {
        throw new HttpError(400, "provider name may only contain letters, digits, '.', '_' and '-'");
    }
    const body = await readJson(request);
    const existing = await deps.store.provider(name);
    const keySecret = body.keySecret === undefined && existing ? existing.keySecret : field(body, "keySecret");
    if (!SECRET_NAME.test(keySecret)) {
        throw new HttpError(400, "keySecret must be an upper-case Worker secret name such as PROVIDER_DEFAULT_KEY");
    }
    await deps.store.upsertProvider({
        name,
        apiUrl: body.apiUrl === undefined && existing ? existing.apiUrl : field(body, "apiUrl"),
        api:
            body.api === undefined && existing
                ? existing.api
                : body.api === "anthropic-messages"
                  ? "anthropic-messages"
                  : "openai-completions",
        keySecret,
        contextWindow: numeric(body, "contextWindow", existing),
        maxTokens: numeric(body, "maxTokens", existing),
        priceInput: numeric(body, "priceInput", existing),
        priceOutput: numeric(body, "priceOutput", existing),
        priceCacheRead: numeric(body, "priceCacheRead", existing),
        priceCacheWrite: numeric(body, "priceCacheWrite", existing),
    });
    return json({ ok: true });
}
