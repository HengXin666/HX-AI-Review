import { posix } from "node:path";
import { ERROR, WARNING } from "../constants.ts";
import { isExcluded } from "../config.ts";
import { lineOf } from "../l0/snapshot.ts";
import { API_DIRS, DATA_SOURCE_PACKAGES, DIRECTORY_FILE_LIMIT, ENTRY_FILES } from "./constants.ts";
import { parseImports, resolveImport, sourceFiles } from "./imports.ts";
import type { Rule, RuleContext, RuleIssue } from "./types.ts";

type Edge = { from: string; to: string; target: string; file: string; line: number; spec: string };

const EDGE_CACHE = new WeakMap<RuleContext, Edge[]>();

function edges(ctx: RuleContext): Edge[] {
    const cached = EDGE_CACHE.get(ctx);
    if (cached) {
        return cached;
    }
    const list: Edge[] = [];
    for (const file of sourceFiles(ctx.snapshot, (path) => isExcluded(ctx.config, path))) {
        for (const ref of parseImports(file, ctx.snapshot.read(file) ?? "")) {
            const target = resolveImport(ctx.snapshot, file, ref.spec);
            if (!target) {
                continue;
            }
            const edge = { from: posix.dirname(file), to: posix.dirname(target), target, file, line: ref.line };
            list.push({ ...edge, spec: ref.spec });
        }
    }
    EDGE_CACHE.set(ctx, list);
    return list;
}

type ImplPath = { root: string };

function implPath(path: string): ImplPath | undefined {
    const segments = path.split("/");
    const index = segments.indexOf("impl");
    if (index < 0 || index === segments.length - 1) {
        return undefined;
    }
    return { root: segments.slice(0, index).join("/") };
}

function inDir(root: string, name: string): string {
    return root === "" ? name : root + "/" + name;
}

function implRoots(ctx: RuleContext): string[] {
    const roots = new Set<string>();
    for (const file of sourceFiles(ctx.snapshot, (path) => isExcluded(ctx.config, path))) {
        const found = implPath(file);
        if (found) {
            roots.add(found.root);
        }
    }
    return [...roots].sort();
}

function rootMatches(root: string, path: string): boolean {
    if (root !== "") {
        return path === root || path.startsWith(root + "/");
    }
    return path === "" || !path.includes("/") || path.startsWith("impl/");
}

function moduleRootOf(path: string, roots: string[]): string | undefined {
    const hits = roots.filter((root) => rootMatches(root, path));
    hits.sort((a, b) => b.length - a.length);
    return hits[0];
}

/** ARCH-001: a module with impl/ exposes a public entry, and no other module imports its impl/. */
function checkImplLayering(ctx: RuleContext): RuleIssue[] {
    const roots = implRoots(ctx);
    const issues: RuleIssue[] = [];
    for (const root of roots) {
        const hasEntry = ENTRY_FILES.some((name) => ctx.snapshot.read(inDir(root, name)) !== undefined);
        if (!hasEntry) {
            issues.push({
                path: inDir(root, "impl"),
                line: 1,
                message: `Module ${root || "repository root"} has impl/ but no public entry`,
                evidence: ENTRY_FILES.join(", "),
            });
        }
    }
    for (const edge of edges(ctx)) {
        const target = implPath(edge.target);
        if (!target) {
            continue;
        }
        const targetRoot = target.root;
        const importerRoot = moduleRootOf(edge.file, roots) ?? posix.dirname(edge.file);
        if (importerRoot === targetRoot) {
            continue;
        }
        issues.push({
            path: edge.file,
            line: edge.line,
            message: `Cross-module import of ${inDir(targetRoot, "impl")} from ${importerRoot || "repository root"}`,
            evidence: edge.spec,
        });
    }
    return issues;
}

function directoryGraph(list: Edge[]): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();
    for (const edge of list) {
        if (edge.from === edge.to) {
            continue;
        }
        const targets = graph.get(edge.from) ?? new Set<string>();
        targets.add(edge.to);
        graph.set(edge.from, targets);
        if (!graph.has(edge.to)) {
            graph.set(edge.to, new Set());
        }
    }
    return graph;
}

function stronglyConnected(graph: Map<string, Set<string>>): string[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const result: string[][] = [];
    let next = 0;
    const visit = (node: string): void => {
        index.set(node, next);
        low.set(node, next);
        next++;
        stack.push(node);
        onStack.add(node);
        for (const target of [...(graph.get(node) ?? [])].sort()) {
            if (!index.has(target)) {
                visit(target);
                low.set(node, Math.min(low.get(node) ?? 0, low.get(target) ?? 0));
            } else if (onStack.has(target)) {
                low.set(node, Math.min(low.get(node) ?? 0, index.get(target) ?? 0));
            }
        }
        if (low.get(node) === index.get(node)) {
            const component: string[] = [];
            let item = "";
            do {
                item = stack.pop() ?? "";
                onStack.delete(item);
                component.push(item);
            } while (item !== node && stack.length > 0);
            result.push(component);
        }
    };
    for (const node of [...graph.keys()].sort()) {
        if (!index.has(node)) {
            visit(node);
        }
    }
    return result;
}

function cyclePath(component: string[], graph: Map<string, Set<string>>): string[] {
    const allowed = new Set(component);
    const start = [...component].sort()[0];
    const seen = new Set<string>([start]);
    const path: string[] = [];
    const walk = (node: string): string[] | undefined => {
        path.push(node);
        for (const target of [...(graph.get(node) ?? [])].filter((item) => allowed.has(item)).sort()) {
            if (target === start) {
                return [...path, start];
            }
            if (!seen.has(target)) {
                seen.add(target);
                const found = walk(target);
                if (found) {
                    return found;
                }
            }
        }
        path.pop();
        return undefined;
    };
    return walk(start) ?? [start];
}

/** ARCH-002: the directory import graph has no cycle. */
function checkCycles(ctx: RuleContext): RuleIssue[] {
    const list = edges(ctx);
    const graph = directoryGraph(list);
    const issues: RuleIssue[] = [];
    for (const component of stronglyConnected(graph)) {
        if (component.length < 2) {
            continue;
        }
        const cycle = cyclePath(component, graph);
        const first = cycle[0];
        const second = cycle[1];
        const edge = list
            .filter((item) => item.from === first && item.to === second)
            .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)[0];
        if (!edge) {
            continue;
        }
        issues.push({
            path: edge.file,
            line: edge.line,
            message: `Dependency cycle: ${cycle.join(" -> ")}`,
            evidence: edge.spec,
        });
    }
    return issues;
}

const LANGUAGES: Record<string, string> = {
    ".ts": "js",
    ".tsx": "js",
    ".js": "js",
    ".jsx": "js",
    ".mjs": "js",
    ".cjs": "js",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
};

function directoryFiles(ctx: RuleContext): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const file of ctx.snapshot.files) {
        if (isExcluded(ctx.config, file)) {
            continue;
        }
        const dir = posix.dirname(file);
        if (dir === "." || dir.split("/").some((segment) => segment.startsWith("."))) {
            continue;
        }
        const list = map.get(dir) ?? [];
        list.push(file);
        map.set(dir, list);
    }
    return map;
}

/** ARCH-003: a directory holds at most 6 files; mixed source languages escalate to Error. */
function checkDirectorySize(ctx: RuleContext): RuleIssue[] {
    const issues: RuleIssue[] = [];
    for (const [dir, files] of directoryFiles(ctx)) {
        if (files.length <= DIRECTORY_FILE_LIMIT) {
            continue;
        }
        const languages = [...new Set(files.map((file) => LANGUAGES[posix.extname(file)]).filter(Boolean))].sort();
        const mixed = languages.length > 1;
        const detail = mixed ? ` and mixes ${languages.join(", ")}` : "";
        issues.push({
            path: dir,
            line: 1,
            message: `Directory holds ${files.length} files, limit ${DIRECTORY_FILE_LIMIT}${detail}`,
            evidence: files.length + " files",
            severity: mixed ? ERROR : WARNING,
            criteria: mixed ? "directory over 6 files with mixed responsibilities" : undefined,
        });
    }
    return issues.sort((a, b) => a.path.localeCompare(b.path));
}

function isDataSource(spec: string): boolean {
    return DATA_SOURCE_PACKAGES.some((name) =>
        name.endsWith("/") ? spec.startsWith(name) : spec === name || spec.startsWith(name + "/"),
    );
}

const CONTAINER_DIRS = ["services", "apps", "packages", "libs", "modules"];

function apiModuleRoot(path: string, roots: string[]): string {
    const known = moduleRootOf(path, roots);
    const segments = path.split("/");
    const container = segments.length > 2 && CONTAINER_DIRS.includes(segments[0]);
    if (container && (known === undefined || known === "")) {
        return segments.slice(0, 2).join("/");
    }
    return known ?? "";
}

function isApiLayer(path: string, roots: string[]): boolean {
    if (implPath(path)) {
        return false;
    }
    const root = apiModuleRoot(path, roots);
    const dir = posix.dirname(path);
    const relative = root === "" ? dir : dir === root ? "" : dir.slice(root.length + 1);
    const segments = relative === "" || relative === "." ? [] : relative.split("/");
    if (segments.some((segment) => API_DIRS.includes(segment))) {
        return true;
    }
    return dir === root && ENTRY_FILES.includes(posix.basename(path));
}

const SQL_KEYWORD = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/;
const STRING_SPAN = /(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g;

function sqlIssues(file: string, text: string): RuleIssue[] {
    const issues: RuleIssue[] = [];
    for (const span of text.matchAll(STRING_SPAN)) {
        const keyword = SQL_KEYWORD.exec(span[0]);
        if (!keyword || keyword.index === undefined) {
            continue;
        }
        issues.push({
            path: file,
            line: lineOf(text, (span.index ?? 0) + keyword.index),
            message: "API layer holds SQL instead of calling a data source interface",
            evidence: span[0].trim().replace(/\s+/g, " ").slice(0, 80),
        });
    }
    return issues;
}

/** ARCH-004: the API layer imports no data-source package and holds no SQL. */
function checkDataSourceSeparation(ctx: RuleContext): RuleIssue[] {
    const roots = implRoots(ctx);
    const issues: RuleIssue[] = [];
    for (const file of sourceFiles(ctx.snapshot, (path) => isExcluded(ctx.config, path))) {
        if (!isApiLayer(file, roots)) {
            continue;
        }
        const text = ctx.snapshot.read(file) ?? "";
        for (const ref of parseImports(file, text)) {
            if (ref.spec.startsWith(".") || !isDataSource(ref.spec)) {
                continue;
            }
            issues.push({
                path: file,
                line: ref.line,
                message: `API layer imports data source ${ref.spec}`,
                evidence: "move the concrete source behind impl/",
            });
        }
        issues.push(...sqlIssues(file, text));
    }
    return issues;
}

export const ARCH_RULES: Rule[] = [
    {
        id: "ARCH-001",
        severity: ERROR,
        description: "Public interface and impl/ stay separated",
        criteria: "module with impl/ exposes a public entry and other modules import only that entry",
        check: checkImplLayering,
    },
    {
        id: "ARCH-002",
        severity: ERROR,
        description: "Dependency direction has no cycle",
        criteria: "the directory import graph is acyclic",
        check: checkCycles,
    },
    {
        id: "ARCH-003",
        severity: WARNING,
        description: "One directory holds at most 6 files",
        criteria: "at most 6 files per directory; mixed source languages escalate to error",
        check: checkDirectorySize,
    },
    {
        id: "ARCH-004",
        severity: ERROR,
        description: "API and data source stay separated",
        criteria: "API layer imports no data-source package and holds no SQL",
        check: checkDataSourceSeparation,
    },
];
