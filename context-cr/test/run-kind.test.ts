import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INIT_FILE } from "../src/constants.ts";

/**
 * The real runKind lives in cli.ts, which runs main() on import and therefore cannot be imported here.
 * This mirrors its rule against a real state directory so the contract it depends on is pinned: init
 * saves the whole InitState, so the kind is at config.kind inside INIT_FILE, not at the top level and
 * not in a file named config.
 */
function readKind(root: string): string {
    try {
        const state = JSON.parse(readFileSync(join(root, ".hx-context-review", INIT_FILE), "utf8")) as {
            config?: { kind?: unknown };
        };
        return state.config?.kind === "code" ? "code" : "context";
    } catch {
        return "context";
    }
}

function withState(state: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "hx-kind-"));
    const dir = join(root, ".hx-context-review");
    mkdirSync(dir, { recursive: true });
    if (state !== undefined) {
        writeFileSync(join(dir, INIT_FILE), JSON.stringify(state));
    }
    return root;
}

test("the kind is read from config.kind inside the init state file", () => {
    const root = withState({ nonce: "n", config: { kind: "code" }, head: "abc" });
    try {
        assert.equal(readKind(root), "code");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a missing state file falls back to context instead of throwing", () => {
    const root = withState(undefined);
    try {
        assert.equal(readKind(root), "context");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a state without config.kind is context, never a guess", () => {
    const root = withState({ nonce: "n", config: { repo: "o/r" } });
    try {
        assert.equal(readKind(root), "context");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
