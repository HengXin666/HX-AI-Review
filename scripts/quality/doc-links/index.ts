// HX-DOCLINK checker: a change to a watched path must change its linked doc in the same range.
// Reads the hx-agent-code scope (HX_QUALITY_SCOPE) in CI; locally pass --base <ref> (default origin/main).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const RULE = "HX-DOCLINK";
const CONFIG = "scripts/quality/doc-links/links.json";

export type Link = { doc: string; watch: string[]; reason: string };
export type Change = { status: string; path: string; oldPath?: string };
export type Finding = {
    ruleId: string;
    severity: "error";
    path: string;
    line: number;
    message: string;
    evidence: string;
    fingerprint: string;
};

function finding(path: string, message: string, evidence: string): Finding {
    const fingerprint = createHash("sha256")
        .update(JSON.stringify([RULE, path, message]))
        .digest("hex");
    return { ruleId: RULE, severity: "error", path, line: 1, message, evidence, fingerprint };
}

export function parseLinks(text: string): Link[] {
    const data = JSON.parse(text) as { links?: unknown };
    if (!Array.isArray(data.links)) {
        throw new Error(`${CONFIG}: links must be an array`);
    }
    return data.links.map((raw) => {
        const item = raw as Partial<Link>;
        if (
            typeof item.doc !== "string" ||
            !Array.isArray(item.watch) ||
            !item.watch.every((w) => typeof w === "string")
        ) {
            throw new Error(`${CONFIG}: each link needs doc (string) and watch (string[])`);
        }
        return { doc: item.doc, watch: item.watch, reason: String(item.reason ?? "") };
    });
}

function touched(changes: Change[]): Set<string> {
    const paths = new Set<string>();
    for (const change of changes) {
        paths.add(change.path);
        if (change.oldPath) {
            paths.add(change.oldPath);
        }
    }
    return paths;
}

/**
 * Pure rule: every link whose watch prefixes match a changed path needs its doc changed too.
 * A missing doc or a watch prefix that matches no tracked file is a stale mapping and also an Error.
 */
export function checkLinks(links: Link[], changes: Change[], tracked: string[]): Finding[] {
    const findings: Finding[] = [];
    const changed = touched(changes);
    for (const link of links) {
        if (!tracked.includes(link.doc)) {
            findings.push(finding(CONFIG, `Linked doc ${link.doc} does not exist`, link.reason));
        }
        for (const prefix of link.watch) {
            if (!tracked.some((path) => path.startsWith(prefix))) {
                findings.push(finding(CONFIG, `Watch prefix ${prefix} matches no tracked file`, link.doc));
            }
        }
        const hits = [...changed].filter((path) => link.watch.some((prefix) => path.startsWith(prefix)));
        if (hits.length && !changed.has(link.doc)) {
            const sample = hits.slice(0, 5).join(", ") + (hits.length > 5 ? ` and ${hits.length - 5} more` : "");
            const message = `${sample} changed (${link.reason}) but ${link.doc} did not; update the doc in the same change`;
            findings.push(finding(link.doc, message, hits.join("\n")));
        }
    }
    return findings;
}

function git(root: string, args: string[]): string {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function localChanges(root: string, base: string): Change[] {
    const from = git(root, ["merge-base", base, "HEAD"]).trim();
    const out = git(root, ["diff", "--name-status", "-z", "-M", from]).split("\0");
    const changes: Change[] = [];
    for (let index = 0; index < out.length - 1;) {
        const status = out[index++];
        if (status.startsWith("R") || status.startsWith("C")) {
            changes.push({ status, oldPath: out[index++], path: out[index++] });
        } else {
            changes.push({ status, path: out[index++] });
        }
    }
    return changes;
}

function main(): void {
    const root = process.cwd();
    const args = process.argv.slice(2);
    const scopeFile = process.env.HX_QUALITY_SCOPE;
    const baseFlag = args.indexOf("--base");
    const changes: Change[] = scopeFile
        ? (JSON.parse(readFileSync(scopeFile, "utf8")) as { changes: Change[] }).changes
        : localChanges(root, baseFlag >= 0 ? args[baseFlag + 1] : "origin/main");
    const configPath = join(root, CONFIG);
    if (!existsSync(configPath)) {
        throw new Error(`${CONFIG} is missing`);
    }
    const tracked = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
    const findings = checkLinks(parseLinks(readFileSync(configPath, "utf8")), changes, tracked);
    process.stdout.write(JSON.stringify(findings, null, 4) + "\n");
}

if (process.argv[1] && process.argv[1].endsWith("doc-links/index.ts")) {
    main();
}
