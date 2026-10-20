import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UTF8 } from "../constants.ts";
import type { ExemptionRef } from "../contract/finding.ts";
import { EXEMPTION_FILE } from "./constants.ts";
import type { Exemption, RuleContext } from "./types.ts";

function field(entry: Record<string, unknown>, name: string, index: number): string {
    const value = entry[name];
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`${EXEMPTION_FILE}[${index}].${name} must be a non-empty string`);
    }
    return value.trim();
}

function parseExemption(value: unknown, index: number): Exemption {
    if (typeof value !== "object" || value === null) {
        throw new Error(`${EXEMPTION_FILE}[${index}] must be an object`);
    }
    const entry = value as Record<string, unknown>;
    const path = field(entry, "path", index).replace(/^\/+/, "").replace(/\/+$/, "");
    if (path === "") {
        throw new Error(`${EXEMPTION_FILE}[${index}].path must name a repository path`);
    }
    if (typeof entry.expires_on_change !== "boolean") {
        throw new Error(`${EXEMPTION_FILE}[${index}].expires_on_change must be a boolean`);
    }
    return {
        ruleId: field(entry, "ruleId", index),
        path,
        reason: field(entry, "reason", index),
        expiresOnChange: entry.expires_on_change,
    };
}

/** Read the repository exemption file; a malformed entry is an error, never a silent skip. */
export function loadExemptions(root: string): Exemption[] {
    const file = join(root, EXEMPTION_FILE);
    if (!existsSync(file)) {
        return [];
    }
    const raw = JSON.parse(readFileSync(file, UTF8)) as { exemptions?: unknown };
    if (!Array.isArray(raw.exemptions)) {
        throw new Error(`${EXEMPTION_FILE}: exemptions must be an array`);
    }
    return raw.exemptions.map((item, index) => parseExemption(item, index));
}

function matches(entryPath: string, path: string): boolean {
    return path === entryPath || path.startsWith(entryPath + "/");
}

/** Most specific exemption for one rule and path, if any. */
export function findExemption(exemptions: Exemption[], ruleId: string, path: string): Exemption | undefined {
    const hits = exemptions.filter((item) => item.ruleId === ruleId && matches(item.path, path));
    hits.sort((a, b) => b.path.length - a.path.length);
    return hits[0];
}

/** True when a changed path falls under the exempted path. */
export function isChanged(changed: string[], path: string): boolean {
    return changed.some((item) => matches(path, item));
}

/** Resolve the exemption state for one finding: active exemptions do not block, changed ones do. */
export function exemptionRef(ctx: RuleContext, ruleId: string, path: string): ExemptionRef | null {
    const entry = findExemption(ctx.exemptions, ruleId, path);
    if (!entry) {
        return null;
    }
    const expired = entry.expiresOnChange && isChanged(ctx.changed, entry.path);
    return {
        path: entry.path,
        reason: entry.reason,
        expiresOnChange: entry.expiresOnChange,
        state: expired ? "expired" : "exempt",
    };
}
