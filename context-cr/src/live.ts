// Live progress events for the console's realtime page. One job: POST each event to the Worker's
// /api/live/emit (cf-admin/worker/realtime/routes.ts), whose parseEvent in events.ts is the schema.
// Best effort by design: a missing endpoint or token disables it, and a failed send is one console.warn,
// never an exception, a retry or a wait the review has to sit through.
import {
    ELLIPSIS,
    ENV,
    LIVE_EMIT_PATH,
    LIVE_LOG_CLIP,
    LIVE_LOG_MAX,
    LIVE_QUEUE_LIMIT,
    LIVE_RULE_MAX,
    LIVE_RUN_ID_MAX,
    LIVE_TEXT_MAX,
    LIVE_TIMEOUT_MS,
} from "./constants.ts";
import type { Severity } from "./contract/finding.ts";
import type { CrKind } from "./contract/kind.ts";

/** Pipeline stages, in runner order; must equal STAGES in events.ts. */
export type LiveStage = "init" | "l0" | "rules" | "scope" | "review" | "publish";
export type LiveStageStatus = "running" | "done" | "failed";
export type LiveLevel = "debug" | "info" | "warn" | "error";
export type LiveRunStatus = "passed" | "warned" | "failed" | "skipped" | "incomplete";

export type LiveProgress = {
    batch?: number;
    batches?: number;
    candidates?: number;
    verifierDone?: number;
    verifierTotal?: number;
};

export type LiveDone = {
    complete: boolean;
    errors: number;
    warnings: number;
    /** Defaults to errors + warnings. */
    findings?: number;
    status?: LiveRunStatus;
    durationMs?: number;
    candidates?: number;
    verified?: number;
};

export type LiveEvent = {
    type: "stage" | "log" | "finding" | "progress" | "done";
    repo: string;
    runId: string;
    kind: CrKind;
    at: string;
    payload: Record<string, unknown>;
};

export interface LiveReport {
    /** False when the reporter is a no-op (no endpoint, no token, or a repo the Worker would refuse). */
    readonly enabled: boolean;
    stage(name: LiveStage, status: LiveStageStatus, durationMs?: number, message?: string): void;
    log(stage: LiveStage, level: LiveLevel, line: string): void;
    finding(ruleId: string, path: string, line?: number, severity?: Severity, message?: string): void;
    progress(stage: LiveStage, progress: LiveProgress): void;
    done(done: LiveDone): void;
    /** Resolves once every queued event was sent or dropped. Never rejects. */
    flush(): Promise<void>;
}

/** Who the events speak for: repo and kind from the /init config, nonce as the runId fallback. */
export type LiveContext = { repo: string; kind: CrKind; nonce: string };

export type LiveOptions = {
    env?: Record<string, string | undefined>;
    fetch?: typeof fetch;
    timeoutMs?: number;
    warn?: (line: string) => void;
    now?: () => Date;
};

/** Same pattern as events.ts repoName: the local "local" repo is not one the Worker accepts. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const NOOP: LiveReport = {
    enabled: false,
    stage() {},
    log() {},
    finding() {},
    progress() {},
    done() {},
    flush: () => Promise.resolve(),
};

/** Keep `text` within `max` characters; an over-long one is cut to `clip` and marked with "...". */
export function clip(text: string, max: number, clipAt = max - ELLIPSIS.length): string {
    return text.length <= max ? text : text.slice(0, clipAt) + ELLIPSIS;
}

/** A nonempty string events.ts accepts, or undefined to leave the optional field out. */
function optText(value: string | undefined, max: number): string | undefined {
    return value ? clip(value, max) : undefined;
}

/** A safe integer >= min, or undefined: events.ts rejects anything else, and the field is optional. */
function optInt(value: number | undefined, min: number): number | undefined {
    return value !== undefined && Number.isSafeInteger(value) && value >= min ? value : undefined;
}

function count(value: number | undefined): number {
    return optInt(value, 0) ?? 0;
}

/** Drop undefined keys so JSON carries only what was set, as events.ts stores it. */
function clean<T extends Record<string, unknown>>(value: T): T {
    for (const key of Object.keys(value)) {
        if (value[key] === undefined) {
            delete value[key];
        }
    }
    return value;
}

/** `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`: shared by every step of one job; the state nonce elsewhere. */
export function liveRunId(env: Record<string, string | undefined>, nonce: string): string {
    const runId = env[ENV.githubRunId];
    const id = runId ? `${runId}-${env[ENV.githubRunAttempt] || "1"}` : nonce;
    return clip(id, LIVE_RUN_ID_MAX, LIVE_RUN_ID_MAX);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

class Reporter implements LiveReport {
    readonly enabled = true;
    private readonly url: string;
    private readonly token: string;
    private readonly base: { repo: string; runId: string; kind: CrKind };
    private readonly send: typeof fetch;
    private readonly timeoutMs: number;
    private readonly warn: (line: string) => void;
    private readonly now: () => Date;
    /** Serial queue: each send starts after the previous one settled, so events arrive in order. */
    private tail: Promise<void> = Promise.resolve();
    private pending = 0;

    constructor(
        endpoint: string,
        token: string,
        ctx: LiveContext,
        env: Record<string, string | undefined>,
        opts: LiveOptions,
    ) {
        this.url = endpoint.replace(/\/+$/, "") + LIVE_EMIT_PATH;
        this.token = token;
        this.base = { repo: ctx.repo, runId: liveRunId(env, ctx.nonce), kind: ctx.kind };
        this.send = opts.fetch ?? fetch;
        this.timeoutMs = opts.timeoutMs ?? LIVE_TIMEOUT_MS;
        this.warn = opts.warn ?? ((line) => console.warn(line));
        this.now = opts.now ?? (() => new Date());
    }

    stage(name: LiveStage, status: LiveStageStatus, durationMs?: number, message?: string): void {
        this.emit(
            "stage",
            clean({ stage: name, status, durationMs: optInt(durationMs, 0), message: optText(message, LIVE_TEXT_MAX) }),
        );
    }

    log(stage: LiveStage, level: LiveLevel, line: string): void {
        // events.ts refuses an empty or over-long message rather than trimming it, so do both here.
        const message = clip(line || "(empty)", LIVE_LOG_MAX, LIVE_LOG_CLIP);
        this.emit("log", { stage, level, message });
    }

    finding(ruleId: string, path: string, line?: number, severity?: Severity, message?: string): void {
        if (!ruleId || !path) {
            return;
        }
        this.emit(
            "finding",
            clean({
                ruleId: clip(ruleId, LIVE_RULE_MAX),
                path: clip(path, LIVE_TEXT_MAX),
                line: optInt(line, 1),
                severity,
                message: optText(message, LIVE_TEXT_MAX),
            }),
        );
    }

    progress(stage: LiveStage, progress: LiveProgress): void {
        const payload: Record<string, unknown> = { stage };
        const batch = optInt(progress.batch, 1);
        if (batch !== undefined) {
            payload.finder = clean({ batch, batches: optInt(progress.batches, 1) });
        }
        const candidates = optInt(progress.candidates, 0);
        if (candidates !== undefined) {
            payload.candidates = candidates;
        }
        const done = optInt(progress.verifierDone, 0);
        if (done !== undefined) {
            payload.verifier = clean({ done, total: optInt(progress.verifierTotal, 0) });
        }
        // events.ts needs at least one of finder, candidates, verifier.
        if (Object.keys(payload).length > 1) {
            this.emit("progress", payload);
        }
    }

    done(done: LiveDone): void {
        const errors = count(done.errors);
        const warnings = count(done.warnings);
        this.emit(
            "done",
            clean({
                complete: done.complete,
                status: done.status,
                durationMs: optInt(done.durationMs, 0),
                counts: clean({
                    findings: done.findings === undefined ? errors + warnings : count(done.findings),
                    errors,
                    warnings,
                    candidates: optInt(done.candidates, 0),
                    verified: optInt(done.verified, 0),
                }),
            }),
        );
    }

    flush(): Promise<void> {
        return this.tail;
    }

    private emit(type: LiveEvent["type"], payload: Record<string, unknown>): void {
        if (this.pending >= LIVE_QUEUE_LIMIT) {
            this.warn(`live ${type} dropped: ${LIVE_QUEUE_LIMIT} events already queued`);
            return;
        }
        const event: LiveEvent = { type, ...this.base, at: this.now().toISOString(), payload };
        this.pending++;
        this.tail = this.tail
            .then(() => this.post(event))
            .finally(() => {
                this.pending--;
            });
    }

    /** One POST, bounded by the timeout. Every failure ends here as a single warning line. */
    private async post(event: LiveEvent): Promise<void> {
        // A referenced timer, unlike AbortSignal.timeout: a step awaiting flush() waits for it to fire.
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new Error(`no answer within ${this.timeoutMs}ms`)),
            this.timeoutMs,
        );
        try {
            const response = await this.send(this.url, {
                method: "POST",
                headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
                body: JSON.stringify(event),
                signal: controller.signal,
            });
            if (!response.ok) {
                const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
                this.warn(`live ${event.type} dropped: HTTP ${response.status} ${detail}`.trim());
            }
        } catch (error) {
            this.warn(`live ${event.type} dropped: ${errorText(error)}`);
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * The reporter for one run step. Without HX_CTX_ENDPOINT or HX_CTX_TOKEN, or for a repo name the Worker
 * would refuse (a local run), it is a no-op: the live page is optional, the review is not.
 */
export function createLive(ctx: LiveContext, opts: LiveOptions = {}): LiveReport {
    const env = opts.env ?? process.env;
    const endpoint = env[ENV.endpoint];
    const token = env[ENV.token];
    if (!endpoint || !token || !REPO_PATTERN.test(ctx.repo)) {
        return NOOP;
    }
    return new Reporter(endpoint, token, ctx, env, opts);
}
