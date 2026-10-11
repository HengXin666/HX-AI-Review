import { posix } from "node:path";
import { AGENTS_FILE, ERROR, README_FILE, RULE, WARNING } from "../constants.ts";
import { makeFinding } from "../contract/finding.ts";
import type { Finding } from "../contract/finding.ts";
import { isExcluded } from "../config.ts";
import type { RepoConfig } from "../config.ts";
import { baseName, isContextFile, lineOf } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";

export type RefKind = "link" | "code";
export type Ref = { from: string; target: string; line: number; kind: RefKind };

const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CODE = /`([^`\s]+)`/g;
const PATH_LIKE = /^[\w.@-]+(?:\/[\w.@-]+)+\/?$/;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;
const FENCE = /^(`{3,}|~{3,})/;

/**
 * Strip fenced blocks so example snippets never count as references; keeps line numbers.
 * A fence closes only with the same character at least as long as its opener (CommonMark).
 */
function withoutFences(text: string): string {
    let open: string | undefined;
    return text
        .split(/\r?\n/)
        .map((line) => {
            const marker = FENCE.exec(line.trim())?.[1];
            if (!open && marker) {
                open = marker;
                return "";
            }
            if (open) {
                const closes =
                    marker && marker[0] === open[0] && marker.length >= open.length && line.trim() === marker;
                if (closes) {
                    open = undefined;
                }
                return "";
            }
            return line;
        })
        .join("\n");
}

/** Malformed percent escapes keep the raw target so CX-DEADREF reports them instead of crashing L0. */
function decodeTarget(target: string): string {
    try {
        return decodeURI(target);
    } catch {
        return target;
    }
}

export function extractRefs(from: string, text: string): Ref[] {
    const body = withoutFences(text);
    const refs: Ref[] = [];
    for (const match of body.matchAll(LINK)) {
        const target = match[1].split("#")[0];
        if (target && !EXTERNAL.test(match[1])) {
            refs.push({ from, target: decodeTarget(target), line: lineOf(body, match.index), kind: "link" });
        }
    }
    for (const match of body.matchAll(CODE)) {
        if (PATH_LIKE.test(match[1]) && !EXTERNAL.test(match[1])) {
            refs.push({ from, target: match[1], line: lineOf(body, match.index), kind: "code" });
        }
    }
    return refs;
}

/** Candidate repository paths for a reference: file-relative, repo-root, then enclosing skill root. */
export function candidates(ref: Ref, skillRoots: string[]): string[] {
    const target = ref.target.replace(/^\.\//, "");
    const own = posix.normalize(posix.join(posix.dirname(ref.from), ref.target));
    const list = [own, posix.normalize(target.replace(/^\//, ""))];
    for (const root of skillRoots) {
        const prefix = root.replace(/\/?$/, "/");
        if (ref.from.startsWith(prefix)) {
            const skill = ref.from.slice(prefix.length).split("/")[0];
            list.push(posix.normalize(prefix + skill + "/" + target));
        }
    }
    return [...new Set(list.map((item) => item.replace(/\/$/, "")))].filter((item) => !item.startsWith(".."));
}

export function resolveRef(snapshot: Snapshot, ref: Ref, skillRoots: string[]): string | undefined {
    return candidates(ref, skillRoots).find((path) => snapshot.exists(path));
}

export function contextRefs(snapshot: Snapshot, config: RepoConfig): Ref[] {
    const refs: Ref[] = [];
    for (const file of snapshot.files) {
        if (isContextFile(file) && !isExcluded(config, file)) {
            refs.push(...extractRefs(file, snapshot.read(file) ?? ""));
        }
    }
    return refs;
}

/**
 * CX-DEADREF: a markdown link to a missing path is an Error; a backticked path is only a
 * Warning because it may name a generated file or a path inside another project.
 */
export function checkDeadRefs(snapshot: Snapshot, config: RepoConfig, refs: Ref[]): Finding[] {
    const findings: Finding[] = [];
    for (const ref of refs) {
        const virtual = config.virtualPaths.some((prefix) => ref.target.startsWith(prefix));
        if (
            ref.target.includes("<") ||
            ref.target.startsWith("@") ||
            virtual ||
            resolveRef(snapshot, ref, config.skillRoots)
        ) {
            continue;
        }
        const severity = ref.kind === "link" ? ERROR : WARNING;
        const message = `Reference \`${ref.target}\` does not resolve to a tracked path`;
        findings.push(makeFinding(RULE.deadref, severity, ref.from, ref.line, message, ref.target));
    }
    return findings;
}

/** CX-ORPHAN: markdown under an orphan root that no other context file points at. */
export function checkOrphans(snapshot: Snapshot, config: RepoConfig, refs: Ref[]): Finding[] {
    const referenced = new Set<string>();
    for (const ref of refs) {
        const hit = resolveRef(snapshot, ref, config.skillRoots);
        if (hit && hit !== ref.from) {
            referenced.add(hit);
        }
    }
    const findings: Finding[] = [];
    for (const file of snapshot.files) {
        const name = baseName(file);
        const rooted = config.orphanRoots.some((root) => file.startsWith(root.replace(/\/?$/, "/")));
        if (!rooted || !isContextFile(file) || isExcluded(config, file)) {
            continue;
        }
        if (name === README_FILE || name === AGENTS_FILE || referenced.has(file)) {
            continue;
        }
        const message = "Document is not referenced by any README, AGENTS or other context file";
        findings.push(makeFinding(RULE.orphan, WARNING, file, 1, message, file));
    }
    return findings;
}
