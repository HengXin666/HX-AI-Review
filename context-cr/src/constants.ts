// Shared literals for the runner. HC-LITERAL requires repeated values to live here.
import type { Severity } from "./contract/finding.ts";

export const TOOL_NAME = "hx-context-review";
export const TOOL_VERSION = "0.3.0";
export const UTF8 = "utf8";

export const ERROR: Severity = "error";
export const WARNING: Severity = "warning";

export const AGENTS_FILE = "AGENTS.md";
export const README_FILE = "README.md";
export const SKILL_FILE = "SKILL.md";
export const DOCS_ROOT = "docs";
export const MARKDOWN_EXT = ".md";

export const CONFIG_FILE = ".hx-context-review.json";
export const STATE_DIR = "scripts/.hx_code_quality/context-review";
export const REPORT_DIR = "scripts/.hx_code_quality/reports";
export const REPORT_NAME = "context-review";
export const INIT_FILE = "init.json";
export const SCOPE_FILE = "scope.json";
export const L0_FILE = "l0.json";
export const AI_FILE = "ai.json";
export const SESSION_FILE = "sessions.jsonl";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbbe4904";
export const ZERO_SHA = /^0+$/;
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export const AGENTS_MAX_LINES = 150;
export const AGENTS_MAX_BYTES = 16384;
export const BUDGET_MAX_BYTES = 65536;
export const DETAIL_LIMIT = 10;
export const DIFF_MAX_BYTES = 60000;
export const DEFAULT_MAX_CANDIDATES = 12;

export const RULE = {
    context: "HC-CONTEXT",
    budget: "HC-BUDGET",
    docname: "HC-DOCNAME",
    deadref: "CX-DEADREF",
    skill: "CX-SKILL",
    orphan: "CX-ORPHAN",
    ai: "CX-AI",
    tool: "tool-error",
} as const;

export const ENV = {
    endpoint: "HX_CTX_ENDPOINT",
    token: "HX_CTX_TOKEN",
    apiKey: "HX_CTX_API_KEY",
    githubToken: "GITHUB_TOKEN",
    githubEnv: "GITHUB_ENV",
    githubOutput: "GITHUB_OUTPUT",
    githubEventPath: "GITHUB_EVENT_PATH",
    githubEventName: "GITHUB_EVENT_NAME",
    githubRepository: "GITHUB_REPOSITORY",
    githubApiUrl: "GITHUB_API_URL",
    githubServerUrl: "GITHUB_SERVER_URL",
    githubSha: "GITHUB_SHA",
    githubHeadRef: "GITHUB_HEAD_REF",
} as const;

export const COMMENT_MARKER = "<!-- hx-context-review -->";
export const PATCH_BRANCH_PREFIX = "hx-ctx/patch-";
export const PI_PROVIDER = "hx-ctx";
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
export const REPORT_FINDING_TOOL = "report_finding";
export const REPORT_VERDICT_TOOL = "report_verdict";
