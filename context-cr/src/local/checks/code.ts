import { posix } from "node:path";
import { ERROR, WARNING } from "../../constants.ts";
import { makeFinding } from "../../contract/finding.ts";
import type { Finding } from "../../contract/finding.ts";
import { lineOf } from "../../l0/snapshot.ts";
import { CODE_FILE_RE, LOCAL_RULE, TEST_PATH_RE, TEXT_FILE_RE } from "./rules.ts";
import type { CheckContext, LocalCheck } from "./rules.ts";

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const FULL_WIDTH_PUNCT = /[\u3000-\u303f\uff01-\uff5e\u2018\u2019\u201c\u201d]/;
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

/** Module specifiers of one source file, in source order. */
function importSpecs(text: string): string[] {
    const specs: string[] = [];
    for (const match of text.matchAll(IMPORT_SPEC)) {
        specs.push(match[1]);
    }
    return specs;
}

/** Resolve a relative specifier against the tracked file set, trying the usual extensions. */
function resolveTarget(from: string, spec: string, tracked: Set<string>): string | undefined {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    const candidates = [
        base,
        base + ".ts",
        base + ".tsx",
        base + ".js",
        base + ".jsx",
        base + "/index.ts",
        base + "/index.tsx",
    ];
    return candidates.find((item) => tracked.has(item));
}

/** True when the edge from - to target did not exist at the comparison base. */
function edgeIsNew(ctx: CheckContext, tracked: Set<string>, from: string, target: string): boolean {
    const before = ctx.readBase(from);
    if (before === undefined) {
        return true;
    }
    return !importSpecs(before).some((spec) => spec.startsWith(".") && resolveTarget(from, spec, tracked) === target);
}

/** True when at least one import edge of the cycle is new relative to the comparison base. */
function cycleIsNew(cycle: string[], ctx: CheckContext, tracked: Set<string>): boolean {
    for (let index = 0; index < cycle.length - 1; index++) {
        if (edgeIsNew(ctx, tracked, cycle[index], cycle[index + 1])) {
            return true;
        }
    }
    return false;
}

/** Depth-first search for an import cycle that both starts at the given file and changes since base. */
function cycleFrom(start: string, ctx: CheckContext, tracked: Set<string>): string[] | undefined {
    const stack: string[] = [];
    const onStack = new Set<string>();
    const done = new Set<string>();
    const walk = (path: string): string[] | undefined => {
        if (onStack.has(path)) {
            const at = stack.indexOf(path);
            const cycle = [...stack.slice(at), path];
            return cycle.includes(start) ? cycle : undefined;
        }
        if (done.has(path)) {
            return undefined;
        }
        const text = ctx.read(path);
        if (!text) {
            return undefined;
        }
        onStack.add(path);
        stack.push(path);
        for (const spec of importSpecs(text)) {
            if (!spec.startsWith(".")) {
                continue;
            }
            const target = resolveTarget(path, spec, tracked);
            const found = target ? walk(target) : undefined;
            if (found) {
                return found;
            }
        }
        stack.pop();
        onStack.delete(path);
        done.add(path);
        return undefined;
    };
    return walk(start);
}

function checkCycles(ctx: CheckContext): Finding[] {
    const tracked = new Set(ctx.tracked.filter((path) => CODE_FILE_RE.test(path)));
    const findings: Finding[] = [];
    const reported = new Set<string>();
    for (const path of ctx.changed) {
        if (!CODE_FILE_RE.test(path) || !tracked.has(path)) {
            continue;
        }
        const cycle = cycleFrom(path, ctx, tracked);
        if (!cycle || !cycleIsNew(cycle, ctx, tracked)) {
            continue;
        }
        const key = [...cycle].sort().join(">");
        if (reported.has(key)) {
            continue;
        }
        reported.add(key);
        const message = "import cycle: " + cycle.join(" -> ");
        findings.push(makeFinding(LOCAL_RULE.cycle, ERROR, path, 1, message, cycle.join("\n")));
    }
    return findings;
}

/** Production code must not reach into a test directory. */
function checkLayering(ctx: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.changed) {
        if (!CODE_FILE_RE.test(path) || TEST_PATH_RE.test(path)) {
            continue;
        }
        const text = ctx.read(path);
        if (!text) {
            continue;
        }
        for (const spec of importSpecs(text)) {
            if (!spec.startsWith(".")) {
                continue;
            }
            const target = posix.normalize(posix.join(posix.dirname(path), spec));
            if (!TEST_PATH_RE.test(target)) {
                continue;
            }
            const message = "production code imports test path " + target;
            findings.push(
                makeFinding(LOCAL_RULE.layering, WARNING, path, lineOf(text, text.indexOf(spec)), message, spec),
            );
        }
    }
    return findings;
}

function dirOf(path: string): string {
    const dir = posix.dirname(path);
    return dir === "." ? "" : dir + "/";
}

/** A directory keeps at most six files; existing larger directories stay a warning. */
function checkDirSize(ctx: CheckContext): Finding[] {
    const watched = new Set(ctx.changed.map(dirOf));
    const byDir = new Map<string, string[]>();
    for (const file of ctx.tracked) {
        const dir = dirOf(file);
        if (!watched.has(dir)) {
            continue;
        }
        const list = byDir.get(dir) ?? [];
        list.push(file);
        byDir.set(dir, list);
    }
    const findings: Finding[] = [];
    for (const [dir, files] of byDir) {
        if (files.length <= 6) {
            continue;
        }
        const message = dir + " holds " + files.length + " files (limit 6)";
        findings.push(makeFinding(LOCAL_RULE.dirSize, WARNING, dir, 1, message, files.slice(0, 8).join("\n")));
    }
    return findings;
}

/** Route handlers reach data through the store port instead of a database handle. */
function checkDataSource(ctx: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.changed) {
        if (!CODE_FILE_RE.test(path) || !path.split("/").includes("routes")) {
            continue;
        }
        const text = ctx.read(path);
        if (!text) {
            continue;
        }
        const direct = /\.prepare\s*\(|D1Database/.exec(text);
        if (!direct || /from\s+["'][^"']*store\//.test(text)) {
            continue;
        }
        const message = "route touches the database directly; go through the store port";
        findings.push(
            makeFinding(LOCAL_RULE.dataSource, WARNING, path, lineOf(text, direct.index), message, direct[0]),
        );
    }
    return findings;
}

/** Deterministic subset of the formatter contract: line endings, indentation, blank edges. */
function formatFindings(path: string, text: string): Finding[] {
    const findings: Finding[] = [];
    if (text.includes("\r")) {
        findings.push(
            makeFinding(LOCAL_RULE.format, ERROR, path, lineOf(text, text.indexOf("\r")), "CRLF line ending", "crlf"),
        );
    }
    const lines = text.split("\n");
    let tab = 0;
    let trailing = 0;
    for (let index = 0; index < lines.length; index++) {
        if (!tab && /^\t/.test(lines[index])) {
            tab = index + 1;
        }
        if (!trailing && /[ \t]+$/.test(lines[index])) {
            trailing = index + 1;
        }
    }
    if (tab) {
        findings.push(
            makeFinding(LOCAL_RULE.format, ERROR, path, tab, "tab indentation, the formatter uses spaces", "tab"),
        );
    }
    if (trailing) {
        findings.push(makeFinding(LOCAL_RULE.format, ERROR, path, trailing, "trailing whitespace", "trailing"));
    }
    if (text.length > 0 && !text.endsWith("\n")) {
        findings.push(makeFinding(LOCAL_RULE.format, ERROR, path, lines.length, "missing final newline", "eof"));
    }
    return findings;
}

type CommentRun = { start: number; lines: string[] };

/** Comment blocks of one source file with their 1-based start line. */
function commentRuns(text: string): CommentRun[] {
    const lines = text.split("\n");
    const runs: CommentRun[] = [];
    let index = 0;
    while (index < lines.length) {
        const trimmed = lines[index].trim();
        if (trimmed.startsWith("//")) {
            const start = index + 1;
            const body: string[] = [];
            while (index < lines.length && lines[index].trim().startsWith("//")) {
                body.push(lines[index]);
                index++;
            }
            runs.push({ start, lines: body });
            continue;
        }
        if (trimmed.startsWith("/*")) {
            const start = index + 1;
            const body: string[] = [];
            while (index < lines.length) {
                body.push(lines[index]);
                const closed = lines[index].includes("*/");
                index++;
                if (closed) {
                    break;
                }
            }
            runs.push({ start, lines: body });
            continue;
        }
        index++;
    }
    return runs;
}

/** Comments describe semantics, stay short and use ASCII punctuation. */
function checkComments(ctx: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.changed) {
        if (!CODE_FILE_RE.test(path)) {
            continue;
        }
        const text = ctx.read(path);
        if (!text) {
            continue;
        }
        for (const run of commentRuns(text)) {
            if (run.lines.length > 10) {
                const message = "comment block has " + run.lines.length + " lines (limit 10)";
                findings.push(makeFinding(LOCAL_RULE.comment, WARNING, path, run.start, message, run.lines[0]));
            }
            const joined = run.lines.join("\n");
            if (FULL_WIDTH_PUNCT.test(joined)) {
                const message = "comment uses non-ASCII punctuation";
                findings.push(makeFinding(LOCAL_RULE.comment, WARNING, path, run.start, message, joined.slice(0, 200)));
            }
        }
    }
    return findings;
}

function dependencyNames(text: string | undefined): Set<string> {
    const names = new Set<string>();
    if (!text) {
        return names;
    }
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return names;
    }
    for (const field of DEP_FIELDS) {
        const value = data[field];
        if (value && typeof value === "object") {
            for (const name of Object.keys(value)) {
                names.add(name);
            }
        }
    }
    return names;
}

/** A dependency that did not exist at base needs a human decision before it lands. */
function checkDependencies(ctx: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const path of ctx.changed) {
        if (!/(^|\/)package[.]json$/.test(path)) {
            continue;
        }
        const now = dependencyNames(ctx.read(path));
        if (!now.size) {
            continue;
        }
        const before = dependencyNames(ctx.readBase(path));
        const added = [...now].filter((name) => !before.has(name)).sort();
        for (const name of added.slice(0, 10)) {
            const message = "new dependency " + name + " needs a human decision";
            findings.push(makeFinding(LOCAL_RULE.dependency, WARNING, path, 1, message, "register it in inventory.md"));
        }
    }
    return findings;
}

export const codeCheck: LocalCheck = {
    id: "code",
    rules: [
        LOCAL_RULE.cycle,
        LOCAL_RULE.layering,
        LOCAL_RULE.dirSize,
        LOCAL_RULE.dataSource,
        LOCAL_RULE.format,
        LOCAL_RULE.comment,
        LOCAL_RULE.dependency,
    ],
    run: (ctx) => {
        const format = ctx.changed.flatMap((path) => {
            const text = ctx.read(path);
            return text && TEXT_FILE_RE.test(path) ? formatFindings(path, text) : [];
        });
        return [
            ...checkCycles(ctx),
            ...checkLayering(ctx),
            ...checkDirSize(ctx),
            ...checkDataSource(ctx),
            ...format,
            ...checkComments(ctx),
            ...checkDependencies(ctx),
        ];
    },
};
