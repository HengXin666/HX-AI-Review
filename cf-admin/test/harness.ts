// Shared in-memory Worker harness for the cf-admin tests.
import type { Deps } from "../worker/http.ts";
import { serve } from "../worker/index.ts";
import { FakeBlobs, FakeStore } from "./fake-store.ts";

export const ORIGIN = "https://cf.test";

export function setup(admin: string | null = "me@test", credentials?: { user: string; password: string }) {
    const store = new FakeStore();
    const blobs = new FakeBlobs();
    let counter = 0;
    const deps: Deps = {
        store,
        blobs,
        secret: (name) => (name === "KEY_DEFAULT" ? "sk-live" : undefined),
        admin: async () => admin,
        credentials,
        overviewUrl: "https://overview.test",
        deployment: { sha: "abc123", accessConfigured: true },
        now: () => new Date("2026-10-11T00:00:00Z"),
        id: () => "run" + ++counter,
    };
    const call = (method: string, path: string, body?: unknown, token?: string, headers?: Record<string, string>) =>
        serve(
            new Request(ORIGIN + path, {
                method,
                headers: {
                    ...(token ? { authorization: "Bearer " + token } : {}),
                    ...headers,
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            }),
            deps,
        );
    return { store, blobs, call };
}

export async function registered(admin = "me@test") {
    const ctx = setup(admin);
    await ctx.call("PUT", "/api/providers/default", {
        apiUrl: "https://llm.test/v1",
        keySecret: "KEY_DEFAULT",
        priceInput: 1,
        priceOutput: 2,
    });
    const created = await ctx.call("POST", "/api/repos", {
        name: "o/r",
        finderModel: "small",
        verifierModel: "large",
        budgetUsd: 1,
    });
    const { token } = (await created.json()) as { token: string };
    return { ...ctx, token };
}
