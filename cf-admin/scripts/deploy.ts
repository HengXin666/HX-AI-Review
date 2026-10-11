// One-click Cloudflare deploy used by .github/workflows/deploy-cf.yml (and runnable locally with the same env).
// Idempotent: creates D1, R2 and the Pages project when missing, applies migrations, deploys Worker and Pages.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_DIR = join(PACKAGE_DIR, ".deploy");
const PAGES_DIR = join(PACKAGE_DIR, "pages");
const COMPATIBILITY_DATE = "2026-10-01";
const TARGETS = ["all", "migrations", "worker", "pages"] as const;

type Target = (typeof TARGETS)[number];

type Settings = {
    target: Target;
    worker: string;
    database: string;
    bucket: string;
    pagesProject: string;
    overviewUrl: string;
    accessAud: string;
    accessTeamDomain: string;
    providerKeyName: string;
    providerKeyValue: string;
    deploySha: string;
    deployRunUrl: string;
};

function env(name: string, fallback = ""): string {
    return process.env[name]?.trim() || fallback;
}

export function settings(): Settings {
    const target = env("HX_DEPLOY_TARGET", "all") as Target;
    if (!TARGETS.includes(target)) {
        throw new Error(`HX_DEPLOY_TARGET must be one of ${TARGETS.join(", ")}`);
    }
    for (const required of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
        if (!env(required)) {
            throw new Error(`${required} is required (repository secret)`);
        }
    }
    const pagesProject = env("HX_PAGES_PROJECT", "hx-context-review");
    return {
        target,
        worker: env("HX_WORKER_NAME", "hx-context-review"),
        database: env("HX_D1_NAME", "hx-context-review"),
        bucket: env("HX_R2_BUCKET", "hx-context-review"),
        pagesProject,
        overviewUrl: env("HX_OVERVIEW_URL", `https://${pagesProject}.pages.dev`),
        accessAud: env("HX_ACCESS_AUD"),
        accessTeamDomain: env("HX_ACCESS_TEAM_DOMAIN"),
        providerKeyName: env("HX_PROVIDER_KEY_NAME"),
        providerKeyValue: env("HX_PROVIDER_KEY_VALUE"),
        deploySha: env("DEPLOY_SHA", env("GITHUB_SHA")),
        deployRunUrl: env("DEPLOY_RUN_URL"),
    };
}

function wrangler(args: string[], options: { cwd?: string; input?: string; quiet?: boolean } = {}): string {
    process.stdout.write(`$ wrangler ${args.join(" ")}\n`);
    const output = execFileSync("pnpm", ["exec", "wrangler", ...args], {
        cwd: options.cwd ?? PACKAGE_DIR,
        encoding: "utf8",
        input: options.input,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
    });
    if (!options.quiet) {
        process.stdout.write(output);
    }
    return output;
}

function tryWrangler(args: string[], options: { cwd?: string } = {}): boolean {
    try {
        wrangler(args, options);
        return true;
    } catch (error) {
        const text = String((error as { stderr?: string }).stderr ?? error);
        process.stdout.write(`(ignored) ${text.split("\n").find((line) => line.trim()) ?? text}\n`);
        return false;
    }
}

function ensureDatabase(name: string): string {
    const find = (): string | undefined => {
        const list = JSON.parse(wrangler(["d1", "list", "--json"], { quiet: true })) as {
            name: string;
            uuid: string;
        }[];
        return list.find((item) => item.name === name)?.uuid;
    };
    const existing = find();
    if (existing) {
        return existing;
    }
    wrangler(["d1", "create", name]);
    const created = find();
    if (!created) {
        throw new Error(`D1 database ${name} was not found after creation`);
    }
    return created;
}

function toml(value: string): string {
    return JSON.stringify(value);
}

/** Generated config with real ids and deploy metadata; the committed wrangler.toml stays a template. */
export function writeWorkerConfig(s: Settings, databaseId: string): string {
    mkdirSync(GENERATED_DIR, { recursive: true });
    const file = join(GENERATED_DIR, "wrangler.toml");
    const vars: Record<string, string> = {
        OVERVIEW_URL: s.overviewUrl,
        ACCESS_AUD: s.accessAud,
        ACCESS_TEAM_DOMAIN: s.accessTeamDomain,
        DEPLOY_SHA: s.deploySha,
        DEPLOYED_AT: new Date().toISOString(),
        DEPLOY_RUN_URL: s.deployRunUrl,
    };
    const lines = [
        `name = ${toml(s.worker)}`,
        `main = "../worker/index.ts"`,
        `compatibility_date = ${toml(COMPATIBILITY_DATE)}`,
        `workers_dev = true`,
        "",
        "[vars]",
        ...Object.entries(vars).map(([key, value]) => `${key} = ${toml(value)}`),
        "",
        "[[d1_databases]]",
        `binding = "DB"`,
        `database_name = ${toml(s.database)}`,
        `database_id = ${toml(databaseId)}`,
        `migrations_dir = "../migrations"`,
        "",
        "[[r2_buckets]]",
        `binding = "BLOBS"`,
        `bucket_name = ${toml(s.bucket)}`,
        "",
    ];
    writeFileSync(file, lines.join("\n"));
    return file;
}

/** Pages Functions forward /api/* to the Worker through a service binding, so the page stays same-origin. */
export function writePagesConfig(s: Settings): void {
    const lines = [
        `name = ${toml(s.pagesProject)}`,
        `pages_build_output_dir = "dist"`,
        `compatibility_date = ${toml(COMPATIBILITY_DATE)}`,
        "",
        "[[services]]",
        `binding = "API"`,
        `service = ${toml(s.worker)}`,
        "",
    ];
    writeFileSync(join(PAGES_DIR, "wrangler.toml"), lines.join("\n"));
}

function summary(lines: string[]): void {
    const text = lines.join("\n") + "\n";
    process.stdout.write(text);
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file) {
        appendFileSync(file, text);
    }
}

function main(): void {
    const s = settings();
    const all = s.target === "all";
    const report = ["## hx-context-review deploy", "", `- target: ${s.target}`, `- commit: ${s.deploySha || "local"}`];

    const databaseId = ensureDatabase(s.database);
    const config = writeWorkerConfig(s, databaseId);
    report.push(`- D1: ${s.database} (${databaseId})`);

    if (all || s.target === "migrations") {
        wrangler(["d1", "migrations", "apply", s.database, "--remote", "--config", config]);
        report.push("- migrations: applied");
    }
    if (all || s.target === "worker") {
        tryWrangler(["r2", "bucket", "create", s.bucket]);
        const out = wrangler(["deploy", "--config", config]);
        const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0] ?? "(see wrangler output)";
        report.push(`- Worker: ${s.worker} at ${url} (use as HX_CTX_ENDPOINT)`);
        if (s.providerKeyName && s.providerKeyValue) {
            wrangler(["secret", "put", s.providerKeyName, "--config", config], { input: s.providerKeyValue });
            report.push(`- secret ${s.providerKeyName}: updated`);
        }
    }
    if (all || s.target === "pages") {
        execFileSync("pnpm", ["exec", "vite", "build"], { cwd: PAGES_DIR, stdio: "inherit" });
        writePagesConfig(s);
        tryWrangler(["pages", "project", "create", s.pagesProject, "--production-branch", "main"], { cwd: PAGES_DIR });
        wrangler(["pages", "deploy", "--project-name", s.pagesProject, "--branch", "main"], { cwd: PAGES_DIR });
        report.push(`- Pages: ${s.overviewUrl}`);
    }
    if (!s.accessAud || !s.accessTeamDomain) {
        report.push(
            "",
            "Access is not configured yet: /api/* answers 403 until HX_ACCESS_AUD and HX_ACCESS_TEAM_DOMAIN are set.",
        );
    }
    summary(report);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main();
}
