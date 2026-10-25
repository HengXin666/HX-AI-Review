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
export const STATE_NAMESPACE = "hx-context-review";
export const KEY_FILE = "api-key";
export const REPORT_DIR = "scripts/.hx_code_quality/reports";
export const REPORT_NAME = "context-review";
export const LOCAL_REPORT_NAME = "local-review";
export const INIT_FILE = "init.json";
export const SCOPE_FILE = "scope.json";
export const L0_FILE = "l0.json";
export const AI_FILE = "ai.json";
export const SESSION_FILE = "sessions.jsonl";

export const ZERO_SHA = /^0+$/;
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export const AGENTS_MAX_LINES = 150;
export const AGENTS_MAX_BYTES = 16384;
export const BUDGET_MAX_BYTES = 65536;
export const DETAIL_LIMIT = 10;
export const DIFF_MAX_BYTES = 60000;
/** POST /runs rejects more than this many findings, so the runner caps its payload to match. */
export const INGEST_FINDING_LIMIT = 500;
export const DEFAULT_MAX_CANDIDATES = 12;
/** Context bytes shown to one finder session; more files are split into further sessions. */
export const CONTEXT_BATCH_BYTES = 40000;
export const EXCERPT_RADIUS = 15;
/** Rough bytes per token, for turning the model's context window into a prompt budget. */
export const BYTES_PER_TOKEN = 4;
/** Prompt space kept for the system prompt, instructions and framing beyond the output reservation. */
export const PROMPT_RESERVE_BYTES = 8000;
/** Floors so even a tiny context window still leaves a usable prompt. */
export const MIN_BATCH_BYTES = 4000;
export const MIN_DIFF_BYTES = 4000;
export const MIN_PROMPT_BYTES = MIN_BATCH_BYTES + MIN_DIFF_BYTES;
/** A finder may keep reporting after a gate rejection; this caps total report_finding calls. */
export const REPORT_CALL_LIMIT = 40;
/** Read-only git tools run async under this timeout, so a hung git cannot outlive the session timer. */
export const GIT_TOOL_TIMEOUT_MS = 30000;
/**
 * The /spend marker runs before the first model session and outside the session timer. A /spend that
 * connects and never answers must not stall the review until the job timeout, so it is aborted and the
 * run fails closed (see Review.session); this bound is also clipped by the review deadline.
 */
export const SPEND_MARK_TIMEOUT_MS = 30000;
/**
 * Per model session: a session that loops or hangs is aborted and the run reported incomplete.
 *
 * The timeout has to fit one session's real work, not just guard against a hang. A code finder reads
 * hunks with its tools and then reasons over them; measured against a slow provider that took 480s for a
 * single hunk and timed out, discarding a review that had already cost 177k input tokens. The run
 * deadline below is still the real bound on total spend, and Review.session clips each session to what is
 * left of it, so raising this cannot extend a run past RUN_DEADLINE_MS.
 */
export const SESSION_MAX_TURNS = 40;
export const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
/** Whole AI review, kept under the 30-minute job timeout so publish still runs and spend is still charged. */
export const RUN_DEADLINE_MS = 20 * 60 * 1000;
/** The reusable workflow's job timeout, and the slice publish needs at the end of it. */
export const JOB_TIMEOUT_MS = 30 * 60 * 1000;
export const PUBLISH_RESERVE_MS = 2 * 60 * 1000;

export const RULE = {
    context: "HC-CONTEXT",
    budget: "HC-BUDGET",
    docname: "HC-DOCNAME",
    deadref: "CX-DEADREF",
    skill: "CX-SKILL",
    orphan: "CX-ORPHAN",
    ai: "CX-AI",
    /** Code CR findings: the diff itself is wrong, not the context describing it. */
    codeAi: "CODE-AI",
    tool: "tool-error",
    exemption: "EXEMPT-001",
} as const;

export const ENV = {
    endpoint: "HX_CTX_ENDPOINT",
    /** The caller workflow's kind input; /init may answer with a different kind, which wins. */
    kind: "HX_CTX_KIND",
    token: "HX_CTX_TOKEN",
    /** The workflow's concurrency group, so /init can hand over a claim cancelled by a newer run. */
    group: "HX_CTX_GROUP",
    apiKey: "HX_CTX_API_KEY",
    githubToken: "GITHUB_TOKEN",
    githubOutput: "GITHUB_OUTPUT",
    runnerTemp: "RUNNER_TEMP",
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
export const REPORT_FINDING_TOOL = "report_finding";
export const REPORT_VERDICT_TOOL = "report_verdict";
