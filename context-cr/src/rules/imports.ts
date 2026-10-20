import { posix } from "node:path";
import type { Snapshot } from "../l0/snapshot.ts";
import { SOURCE_EXTENSIONS } from "./constants.ts";

export type ImportRef = { spec: string; line: number };

const TS_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
const PY_FROM = /^\s*from\s+([.\w]+)\s+import\b/;
const PY_IMPORT = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/;
const TS_CANDIDATES = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const ESM_SWAPS: Record<string, string[]> = {
    ".js": [".ts", ".tsx"],
    ".jsx": [".tsx"],
    ".mjs": [".mts"],
    ".cjs": [".cts"],
};

export function isSource(path: string): boolean {
    return SOURCE_EXTENSIONS.includes(posix.extname(path));
}

function pythonImports(line: string, number: number): ImportRef[] {
    const refs: ImportRef[] = [];
    const from = PY_FROM.exec(line);
    if (from) {
        refs.push({ spec: from[1], line: number });
    }
    const plain = PY_IMPORT.exec(line);
    if (plain) {
        for (const spec of plain[1].split(",")) {
            refs.push({ spec: spec.trim(), line: number });
        }
    }
    return refs;
}

/** Line-based import extraction; a quoted path inside ordinary code may still be reported. */
export function parseImports(path: string, text: string): ImportRef[] {
    const refs: ImportRef[] = [];
    const python = posix.extname(path) === ".py";
    text.split(/\r?\n/).forEach((line, index) => {
        if (python) {
            refs.push(...pythonImports(line, index + 1));
            return;
        }
        for (const match of line.matchAll(TS_IMPORT)) {
            refs.push({ spec: match[1], line: index + 1 });
        }
    });
    return refs;
}

function tracked(snapshot: Snapshot, path: string): string | undefined {
    return snapshot.read(path) === undefined ? undefined : path;
}

function firstExisting(snapshot: Snapshot, candidates: string[]): string | undefined {
    for (const candidate of candidates) {
        const hit = tracked(snapshot, candidate);
        if (hit) {
            return hit;
        }
    }
    return undefined;
}

function typescriptCandidates(base: string): string[] {
    const ext = posix.extname(base);
    const swapped = (ESM_SWAPS[ext] ?? []).map((replacement) => base.slice(0, -ext.length) + replacement);
    return [
        base,
        ...swapped,
        ...TS_CANDIDATES.map((item) => base + item),
        ...TS_CANDIDATES.map((item) => base + "/index" + item),
    ];
}

function resolveTypeScript(snapshot: Snapshot, from: string, spec: string): string | undefined {
    if (!spec.startsWith(".")) {
        return undefined;
    }
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    if (base.startsWith("..")) {
        return undefined;
    }
    return firstExisting(snapshot, typescriptCandidates(base));
}

function pythonBases(from: string): string[] {
    const bases: string[] = [];
    let base = posix.dirname(from);
    while (base !== "." && base !== "") {
        bases.push(base);
        base = posix.dirname(base);
    }
    bases.push("");
    return bases;
}

function resolvePython(snapshot: Snapshot, from: string, spec: string): string | undefined {
    const match = /^(\.*)(.*)$/.exec(spec);
    if (!match) {
        return undefined;
    }
    const dots = match[1].length;
    const tail = match[2].replace(/\./g, "/");
    if (dots > 0) {
        let base = posix.dirname(from);
        for (let level = 1; level < dots; level++) {
            base = posix.dirname(base);
        }
        const target = tail ? posix.join(base, tail) : base;
        return firstExisting(snapshot, [target + ".py", target + "/__init__.py"]);
    }
    if (tail === "") {
        return undefined;
    }
    for (const base of pythonBases(from)) {
        const target = base === "" ? tail : base + "/" + tail;
        const hit = firstExisting(snapshot, [target + ".py", target + "/__init__.py"]);
        if (hit) {
            return hit;
        }
    }
    return undefined;
}

/** Resolve one import to a tracked file; package imports resolve to undefined. */
export function resolveImport(snapshot: Snapshot, from: string, spec: string): string | undefined {
    return posix.extname(from) === ".py"
        ? resolvePython(snapshot, from, spec)
        : resolveTypeScript(snapshot, from, spec);
}

/** Every source file outside excluded paths, sorted for stable output. */
export function sourceFiles(snapshot: Snapshot, excluded: (path: string) => boolean): string[] {
    return snapshot.files.filter((path) => isSource(path) && !excluded(path));
}
