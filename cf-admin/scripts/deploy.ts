// One-click Cloudflare deploy used by .github/workflows/deploy-cf.yml (and runnable locally with the same env).
// Idempotent: creates D1 and R2 when missing, applies migrations, then builds the overview SPA and ships it
// inside the Worker as static assets, so one Worker serves both the admin page and the API on one hostname.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_DIR = join(PACKAGE_DIR, ".deploy");
const PAGES_DIR = join(PACKAGE_DIR, "pages");
/** Where the overview SPA is built; the Worker serves it as static assets, so no Pages project is needed. */
const ASSETS_DIR = join(GENERATED_DIR, "assets");
const COMPATIBILITY_DATE = "2026-10-01";
const RULE_BACKFILL = join(PACKAGE_DIR, "migrations", "0004_rule_results.sql");
const TARGETS = ["all", "migrations", "worker"] as const;

type Target = (typeof TARGETS)[number];

type Settings = {
    target: Target;
    worker: string;
    database: string;
    bucket: string;
    overviewDomain: string;
    overviewUrl: string;
    accessAud: string;
    accessTeamDomain: string;
    providerKeyName: string;
    providerKeyValue: string;
    deploySha: string;
    deployRunUrl: string;
    adminUser: string;
    adminPassword: string;
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
    const providerKeyName = env("HX_PROVIDER_KEY_NAME");
    if (providerKeyName && !env("HX_PROVIDER_KEY_VALUE")) {
        throw new Error("provider-key-name is set but the HX_PROVIDER_API_KEY secret is empty");
    }
    if (providerKeyName && target !== "all" && target !== "worker") {
        throw new Error("provider-key-name only applies when target is all or worker");
    }
    return {
        target,
        worker: env("HX_WORKER_NAME", "hx-context-review"),
        database: env("HX_D1_NAME", "hx-context-review"),
        bucket: env("HX_R2_BUCKET", "hx-context-review"),
        overviewDomain: env("HX_OVERVIEW_DOMAIN"),
        overviewUrl: env("HX_OVERVIEW_URL"),
        accessAud: env("HX_ACCESS_AUD"),
        accessTeamDomain: env("HX_ACCESS_TEAM_DOMAIN"),
        providerKeyName,
        providerKeyValue: env("HX_PROVIDER_KEY_VALUE"),
        deploySha: env("DEPLOY_SHA", env("GITHUB_SHA")),
        deployRunUrl: env("DEPLOY_RUN_URL"),
        adminUser: env("HX_ADMIN_USER", "admin"),
        adminPassword: env("HX_ADMIN_PASSWORD", "hx-context-review"),
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

type Zone = { id: string; name: string };

/** Zone that owns the custom hostname, so the Worker route can be registered on it. */
export async function findZone(hostname: string): Promise<Zone | undefined> {
    const labels = hostname.split(".");
    for (let index = 1; index < labels.length - 1; index += 1) {
        const name = labels.slice(index).join(".");
        const url = `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(name)}`;
        const response = await fetch(url, { headers: { authorization: `Bearer ${env("CLOUDFLARE_API_TOKEN")}` } });
        if (!response.ok) {
            throw new Error(`Zone lookup failed for ${name}: ${response.status}`);
        }
        const body = (await response.json()) as { result?: Zone[] };
        const zone = body.result?.[0];
        if (zone) {
            return zone;
        }
    }
    return undefined;
}

/**
 * Route HX_OVERVIEW_DOMAIN to the Worker with a zone route. A Worker route does not need DNS:Edit: the hostname
 * only needs an existing proxied DNS record (a proxied A/CNAME at the placeholder IP), which is what a
 * "preferred IP" setup already has. Idempotent: an existing route with the same script is reused.
 */
export async function ensureWorkerRoute(zoneId: string, hostname: string, worker: string): Promise<string> {
    const pattern = `${hostname}/*`;
    const base = `https://api.cloudflare.com/client/v4/zones/${zoneId}/workers/routes`;
    const headers = {
        authorization: `Bearer ${env("CLOUDFLARE_API_TOKEN")}`,
        "content-type": "application/json",
    };
    const list = await fetch(base, { headers });
    if (!list.ok) {
        throw new Error(`Worker route lookup failed for ${hostname}: ${list.status}`);
    }
    const routes = (await list.json()) as { result?: { pattern: string; script: string }[] };
    const existing = routes.result?.find((route) => route.pattern === pattern);
    if (existing?.script === worker) {
        return "reused";
    }
    const response = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ pattern, script: worker }),
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`routing ${hostname} to ${worker} failed: ${response.status} ${detail.slice(0, 300)}`);
    }
    return "created";
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
        ADMIN_USER: s.adminUser,
        ADMIN_PASSWORD: s.adminPassword,
    };
    const lines = [
        `name = ${toml(s.worker)}`,
        `main = "../worker/index.ts"`,
        `compatibility_date = ${toml(COMPATIBILITY_DATE)}`,
        `workers_dev = true`,
        "",
        "[assets]",
        `directory = ${toml(ASSETS_DIR)}`,
        `binding = "ASSETS"`,
        `not_found_handling = "single-page-application"`,
        `run_worker_first = true`,
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

function summary(lines: string[]): void {
    const text = lines.join("\n") + "\n";
    process.stdout.write(text);
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file) {
        appendFileSync(file, text);
    }
}

async function main(): Promise<void> {
    const s = settings();
    const all = s.target === "all";
    const worker = all || s.target === "worker";
    const report = ["## hx-context-review deploy", "", `- target: ${s.target}`, `- commit: ${s.deploySha || "local"}`];

    if (all || worker || s.target === "migrations") {
        const databaseId = ensureDatabase(s.database);
        const config = writeWorkerConfig(s, databaseId);
        report.push(`- D1: ${s.database} (${databaseId})`);
        wrangler(["d1", "migrations", "apply", s.database, "--remote", "--config", config]);
        report.push("- migrations: applied");
        // Ordering matters for availability: every migration adds columns with a DEFAULT or whole tables, so
        // the old Worker keeps serving while migrations run, and the new Worker is only deployed once the
        // schema it expects exists. Deploying first would leave the new code querying columns that are not
        // there yet, which is the only direction that breaks a live site.
        if (worker) {
            tryWrangler(["r2", "bucket", "create", s.bucket]);
            // The SPA is built into the assets directory the Worker config points at, so one deploy ships both.
            execFileSync("pnpm", ["exec", "vite", "build", "--outDir", ASSETS_DIR, "--emptyOutDir"], {
                cwd: PAGES_DIR,
                stdio: "inherit",
            });
            report.push("- overview assets: built into the Worker");
            const out = wrangler(["deploy", "--config", config]);
            const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0] ?? "(see wrangler output)";
            report.push(`- Worker: ${s.worker} at ${url} (use as HX_CTX_ENDPOINT)`);
            wrangler(["d1", "execute", s.database, "--remote", "--config", config, "--file", RULE_BACKFILL]);
            report.push("- rule_results: backfill replayed after the Worker rollout");
            if (s.providerKeyName) {
                wrangler(["secret", "put", s.providerKeyName, "--config", config], { input: s.providerKeyValue });
                report.push(`- secret ${s.providerKeyName}: updated`);
            }
        }
    }
    if (worker && s.overviewDomain) {
        const zone = await findZone(s.overviewDomain);
        if (!zone) {
            throw new Error(`no Cloudflare zone found for ${s.overviewDomain}: add the domain to this account first`);
        }
        const route = await ensureWorkerRoute(zone.id, s.overviewDomain, s.worker);
        report.push(`- Worker route: ${s.overviewDomain}/* (zone ${zone.name}, ${route})`);
        if (!s.overviewUrl) {
            report.push(`- OVERVIEW_URL is empty: set HX_OVERVIEW_URL=https://${s.overviewDomain} and redeploy.`);
        }
    }
    if (!s.accessAud || !s.accessTeamDomain) {
        report.push(
            "",
            "Access is not configured. Password login still works when ADMIN_USER and ADMIN_PASSWORD are set " +
                "(defaults admin / hx-context-review, override with HX_ADMIN_USER and HX_ADMIN_PASSWORD).",
        );
    }
    summary(report);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}
