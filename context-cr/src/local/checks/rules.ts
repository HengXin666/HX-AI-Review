import type { Finding } from "../../contract/finding.ts";
import type { LocalChange } from "../worktree.ts";

/** Rule ids of the shared gate namespace; local mode reports the same ids as CI. */
export const LOCAL_RULE = {
    layering: "ARCH-001",
    cycle: "ARCH-002",
    dirSize: "ARCH-003",
    dataSource: "ARCH-004",
    format: "STYLE-001",
    lint: "STYLE-002",
    comment: "STYLE-003",
    dependency: "STYLE-004",
    docLink: "DOC-001",
    docSync: "DOC-002",
    agentsStructure: "CTX-001",
    skillStructure: "CTX-002",
    workflow: "CI-001",
    meta: "META-001",
} as const;

/** Paths that hold tests; they live on the test branch, never on the code branch. */
export const TEST_PATH_RE = /(^|\/)(test|tests|e2e|perf|fixtures|test-request|test-ui)(\/|$)|[.](test|spec)[.](ts|tsx|js|jsx)$/;

export const CODE_FILE_RE = /[.](ts|tsx|js|jsx|mjs|cjs)$/;

export const TEXT_FILE_RE = /[.](ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|css|html)$/;

/** Inputs every local check receives; read returns the worktree text of a repository path. */
export type CheckContext = {
    root: string;
    base: string;
    changes: LocalChange[];
    changed: string[];
    tracked: string[];
    read: (path: string) => string | undefined;
    readBase: (path: string) => string | undefined;
    exists: (path: string) => boolean;
};

export type LocalCheck = { id: string; rules: string[]; run: (ctx: CheckContext) => Finding[] };
