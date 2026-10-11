// Run state lives outside the reviewed checkout, so a pull request can never commit forged state files.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV, KEY_FILE, STATE_NAMESPACE, UTF8 } from "./constants.ts";

export function stateDir(root: string): string {
    const base = process.env[ENV.runnerTemp] || tmpdir();
    const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
    return join(base, STATE_NAMESPACE, id);
}

/** Start a fresh run: drop every file of earlier runs and return the nonce later stages must echo. */
export function resetState(root: string): string {
    const dir = stateDir(root);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return randomUUID();
}

export function stateFile(root: string, name: string): string {
    const dir = stateDir(root);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, name);
}

export function save(root: string, name: string, value: unknown): void {
    writeFileSync(stateFile(root, name), JSON.stringify(value, null, 4) + "\n", UTF8);
}

export function load<T>(root: string, name: string): T | undefined {
    const file = join(stateDir(root), name);
    return existsSync(file) ? (JSON.parse(readFileSync(file, UTF8)) as T) : undefined;
}

/** Printable ASCII without whitespace: rules out CR/LF injection into workflow commands or files. */
export function assertSafeSecret(value: string): void {
    if (!/^[\x21-\x7e]+$/.test(value)) {
        throw new Error("init returned an api key with whitespace or non-printable characters");
    }
}

/**
 * The model key never enters GITHUB_ENV, where every later step and third-party action would see it.
 * It is masked, kept in a 0600 file in RUNNER_TEMP, and removed as soon as the review step reads it.
 */
export function storeKey(root: string, apiKey: string): void {
    assertSafeSecret(apiKey);
    process.stdout.write(`::add-mask::${apiKey}\n`);
    writeFileSync(stateFile(root, KEY_FILE), apiKey, { encoding: UTF8, mode: 0o600 });
}

export function takeKey(root: string): string | undefined {
    const file = join(stateDir(root), KEY_FILE);
    const fromEnv = process.env[ENV.apiKey];
    if (!existsSync(file)) {
        return fromEnv;
    }
    const key = readFileSync(file, UTF8);
    rmSync(file, { force: true });
    return key;
}

export function dropKey(root: string): void {
    rmSync(join(stateDir(root), KEY_FILE), { force: true });
}

export function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`environment variable ${name} is required`);
    }
    return value;
}

/** GitHub Actions key=value outputs; values are fixed literals, never data from the network. */
export function setOutput(name: string, value: "true" | "false"): void {
    const file = process.env[ENV.githubOutput];
    if (file) {
        appendFileSync(file, `${name}=${value}\n`);
    }
}
