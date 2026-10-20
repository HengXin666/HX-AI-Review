import { posix } from "node:path";
import { ERROR, WARNING } from "../../constants.ts";
import { makeFinding } from "../../contract/finding.ts";
import type { Finding } from "../../contract/finding.ts";
import { withoutFences } from "../../l0/refs.ts";
import { lineOf } from "../../l0/snapshot.ts";
import { LOCAL_RULE } from "./rules.ts";
import type { CheckContext, LocalCheck } from "./rules.ts";

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL_RE = /^(#|https?:\/\/|mailto:|tel:|data:)/i;
const LINKS_CONFIG = "scripts/quality/doc-links/links.json";

type LinkRule = { doc: string; watch: string[] };

/** Repository path a markdown link points at, without fragment or query. */
function linkTarget(from: string, raw: string): string | undefined {
    const withoutAnchor = raw.split("#")[0].split("?")[0];
    if (!withoutAnchor) {
        return undefined;
    }
    let decoded: string;
    try {
        decoded = decodeURI(withoutAnchor);
    } catch {
        decoded = withoutAnchor;
    }
    return decoded.startsWith("/") ? decoded.slice(1) : posix.normalize(posix.join(posix.dirname(from), decoded));
}

function checkDocLinks(ctx: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.changed) {
        if (!path.endsWith(".md")) {
            continue;
        }
        const text = ctx.read(path);
        if (!text) {
            continue;
        }
        const body = withoutFences(text);
        for (const match of body.matchAll(LINK_RE)) {
            const raw = match[1];
            if (EXTERNAL_RE.test(raw)) {
                continue;
            }
            const target = linkTarget(path, raw);
            if (!target) {
                continue;
            }
            const line = lineOf(body, match.index);
            if (target.startsWith("..")) {
                const message = "link escapes the repository: " + raw;
                findings.push(makeFinding(LOCAL_RULE.docLink, ERROR, path, line, message, raw));
                continue;
            }
            if (!ctx.exists(target)) {
                const message = "link target does not exist: " + target;
                findings.push(makeFinding(LOCAL_RULE.docLink, ERROR, path, line, message, raw));
            }
        }
    }
    return findings;
}

type LinkRules = { rules: LinkRule[]; problem?: Finding };

/** Mapping that forces a watched path and its document into the same change. */
function readLinkRules(ctx: CheckContext): LinkRules {
    const text = ctx.read(LINKS_CONFIG);
    if (!text) {
        const message = "doc sync config is missing: " + LINKS_CONFIG;
        return { rules: [], problem: makeFinding(LOCAL_RULE.docSync, ERROR, LINKS_CONFIG, 1, message, LINKS_CONFIG) };
    }
    let data: { links?: unknown };
    try {
        data = JSON.parse(text) as { links?: unknown };
    } catch {
        const message = "doc sync config is not valid JSON: " + LINKS_CONFIG;
        return { rules: [], problem: makeFinding(LOCAL_RULE.docSync, ERROR, LINKS_CONFIG, 1, message, LINKS_CONFIG) };
    }
    if (!Array.isArray(data.links)) {
        const message = "doc sync config needs a links array: " + LINKS_CONFIG;
        return { rules: [], problem: makeFinding(LOCAL_RULE.docSync, ERROR, LINKS_CONFIG, 1, message, LINKS_CONFIG) };
    }
    const rules = data.links.filter(
        (item): item is LinkRule =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as LinkRule).doc === "string" &&
            Array.isArray((item as LinkRule).watch),
    );
    return { rules };
}

function checkDocSync(ctx: CheckContext): Finding[] {
    const { rules, problem } = readLinkRules(ctx);
    const changed = new Set(ctx.changed);
    const findings: Finding[] = problem ? [problem] : [];
    for (const rule of rules) {
        const hits = ctx.changed.filter((path) => rule.watch.some((prefix) => path.startsWith(prefix)));
        if (!hits.length || changed.has(rule.doc)) {
            continue;
        }
        const message = hits[0] + " changed but " + rule.doc + " did not";
        findings.push(makeFinding(LOCAL_RULE.docSync, ERROR, hits[0], 1, message, hits.slice(0, 5).join("\n")));
    }
    return findings;
}

function sibling(dir: string, name: string): string {
    return dir ? dir + "/" + name : name;
}

function checkAgents(ctx: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.changed) {
        const name = posix.basename(path);
        if (name !== "AGENTS.md" && name !== "README.md") {
            continue;
        }
        const text = ctx.read(path);
        if (!text) {
            continue;
        }
        const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
        const partner = sibling(dir, name === "AGENTS.md" ? "README.md" : "AGENTS.md");
        if (!ctx.exists(partner)) {
            const message = name + " without " + posix.basename(partner) + " in the same directory";
            findings.push(makeFinding(LOCAL_RULE.agentsStructure, ERROR, path, 1, message, partner));
        }
        if (name !== "AGENTS.md") {
            continue;
        }
        const lines = text.split("\n").length;
        if (lines > 150) {
            const message = "AGENTS.md has " + lines + " lines (limit 150)";
            findings.push(makeFinding(LOCAL_RULE.agentsStructure, ERROR, path, 151, message, String(lines)));
        }
        if (!text.startsWith("# ")) {
            const first = text.split("\n")[0] ?? "";
            findings.push(
                makeFinding(LOCAL_RULE.agentsStructure, WARNING, path, 1, "AGENTS.md has no level-1 heading", first),
            );
        }
    }
    return findings;
}

/** YAML scalar value without the optional matching quotes. */
function yamlScalar(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    const quoted = /^(["'])(.*)\1$/.exec(trimmed);
    return quoted ? quoted[2] : trimmed;
}

function checkSkills(ctx: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.changed) {
        if (posix.basename(path) !== "SKILL.md") {
            continue;
        }
        const text = ctx.read(path);
        if (!text) {
            continue;
        }
        const lines = text.split("\n");
        const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
        if (close < 0) {
            findings.push(makeFinding(LOCAL_RULE.skillStructure, ERROR, path, 1, "SKILL.md has no front matter", path));
            continue;
        }
        const front = lines.slice(1, close);
        const name = yamlScalar(front.find((line) => line.startsWith("name:"))?.slice(5));
        const description = yamlScalar(front.find((line) => line.startsWith("description:"))?.slice(12));
        const dir = posix.basename(posix.dirname(path));
        if (name !== dir) {
            const message = "front matter name " + (name ?? "(missing)") + " differs from directory " + dir;
            findings.push(makeFinding(LOCAL_RULE.skillStructure, ERROR, path, 2, message, name ?? ""));
        }
        if (!description) {
            findings.push(
                makeFinding(LOCAL_RULE.skillStructure, ERROR, path, 3, "front matter needs a description", ""),
            );
        }
    }
    return findings;
}

export const docsCheck: LocalCheck = {
    id: "docs",
    rules: [LOCAL_RULE.docLink, LOCAL_RULE.docSync, LOCAL_RULE.agentsStructure, LOCAL_RULE.skillStructure],
    run: (ctx) => [...checkDocLinks(ctx), ...checkDocSync(ctx), ...checkAgents(ctx), ...checkSkills(ctx)],
};
