// Live event schema shared by the RealtimeHub Durable Object, POST /api/live/emit and the in-Worker emit helper.
// Every field is checked here, once: an invalid event is a 400 at the edge, never a half-broadcast message.
import { HttpError } from "../http.ts";

export const EVENT_STAGE = "stage";
export const EVENT_LOG = "log";
export const EVENT_FINDING = "finding";
export const EVENT_PROGRESS = "progress";
export const EVENT_DONE = "done";
/** The five event types a producer may emit; snapshot and ping are server-only control frames. */
export const EVENT_TYPES = [EVENT_STAGE, EVENT_LOG, EVENT_FINDING, EVENT_PROGRESS, EVENT_DONE] as const;

/** Server to client only: the first frame on every connection, carrying the active runs. */
export const FRAME_SNAPSHOT = "snapshot";
/** Server to client heartbeat; the client answers with {"type":"pong"}. */
export const FRAME_PING = "ping";
/** Client to server heartbeat answer. */
export const FRAME_PONG = "pong";

/** Pipeline stages in runner order (context-cr subcommands). */
export const STAGES = ["init", "l0", "rules", "scope", "review", "publish"] as const;
export const STAGE_STATUSES = ["running", "done", "failed"] as const;
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const KINDS = ["context", "code"] as const;
export const SEVERITIES = ["error", "warning"] as const;
export const ORIGINS = ["new", "historical"] as const;
export const RUN_STATUSES = ["passed", "warned", "failed", "skipped", "incomplete"] as const;

export const MAX_RUN_ID = 128;
export const MAX_LOG_MESSAGE = 4000;
export const MAX_TEXT = 1000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type EventType = (typeof EVENT_TYPES)[number];
export type Stage = (typeof STAGES)[number];
export type StageStatus = (typeof STAGE_STATUSES)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LiveKind = (typeof KINDS)[number];

export type StagePayload = { stage: Stage; status: StageStatus; durationMs?: number; message?: string };
export type LogPayload = { stage: Stage; level: LogLevel; message: string };
export type FindingPayload = {
    ruleId: string;
    path: string;
    line?: number;
    severity?: (typeof SEVERITIES)[number];
    message?: string;
    origin?: (typeof ORIGINS)[number];
};
export type ProgressPayload = {
    stage: Stage;
    finder?: { batch: number; batches?: number };
    candidates?: number;
    verifier?: { done: number; total?: number };
};
export type DonePayload = {
    complete: boolean;
    status?: (typeof RUN_STATUSES)[number];
    durationMs?: number;
    counts: { findings: number; errors: number; warnings: number; candidates?: number; verified?: number };
};

type Envelope<T extends EventType, P> = {
    type: T;
    repo: string;
    runId: string;
    kind: LiveKind;
    at: string;
    payload: P;
};

/** What a producer sends. */
export type LiveEventInput =
    | Envelope<typeof EVENT_STAGE, StagePayload>
    | Envelope<typeof EVENT_LOG, LogPayload>
    | Envelope<typeof EVENT_FINDING, FindingPayload>
    | Envelope<typeof EVENT_PROGRESS, ProgressPayload>
    | Envelope<typeof EVENT_DONE, DonePayload>;

/** What a subscriber receives: the input plus a per-repo, strictly increasing id used for resume. */
export type LiveEvent = LiveEventInput & { id: number };

/** One run the hub believes is in flight; the snapshot lists these. */
export type ActiveRun = {
    runId: string;
    kind: LiveKind;
    stage: Stage | null;
    status: StageStatus | null;
    startedAt: string;
    updatedAt: string;
    lastEventId: number;
};

export type SnapshotFrame = {
    type: typeof FRAME_SNAPSHOT;
    repo: string;
    at: string;
    payload: {
        runs: ActiveRun[];
        /** Newest event id in the room (0 when empty). */
        lastEventId: number;
        /** Oldest event id still buffered (0 when empty). */
        oldestEventId: number;
        /** Events that follow this frame because the client resumed with lastEventId. */
        replayed: number;
        /** True when the client resumed from an id older than the buffer: some events are gone, refetch state. */
        gap: boolean;
    };
};

export type PingFrame = { type: typeof FRAME_PING; at: string };

function bad(message: string): never {
    throw new HttpError(400, message);
}

function obj(value: unknown, what: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        bad(`${what} must be an object`);
    }
    return value as Record<string, unknown>;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
        bad(`${what} must be one of ${allowed.join(", ")}`);
    }
    return value as T;
}

function str(value: unknown, what: string, max: number): string {
    if (typeof value !== "string" || !value) {
        bad(`${what} must be a nonempty string`);
    }
    if (value.length > max) {
        bad(`${what} must be at most ${max} characters`);
    }
    return value;
}

function optStr(value: unknown, what: string, max: number): string | undefined {
    return value === undefined ? undefined : str(value, what, max);
}

function int(value: unknown, what: string, min: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < min) {
        bad(`${what} must be an integer >= ${min}`);
    }
    return value as number;
}

function optInt(value: unknown, what: string, min: number): number | undefined {
    return value === undefined ? undefined : int(value, what, min);
}

/** Drop undefined keys so the stored and broadcast JSON only carries what the producer sent. */
function clean<T extends Record<string, unknown>>(value: T): T {
    for (const key of Object.keys(value)) {
        if (value[key] === undefined) {
            delete value[key];
        }
    }
    return value;
}

export function repoName(value: unknown): string {
    if (typeof value !== "string" || !REPO_PATTERN.test(value)) {
        bad("repo must be a full name like owner/name");
    }
    return value;
}

/** Room key: GitHub names are case-insensitive, so Owner/Repo and owner/repo share one room. */
export function roomKey(repo: string): string {
    return repo.toLowerCase();
}

function stagePayload(p: Record<string, unknown>): StagePayload {
    return clean({
        stage: oneOf(p.stage, STAGES, "payload.stage"),
        status: oneOf(p.status, STAGE_STATUSES, "payload.status"),
        durationMs: optInt(p.durationMs, "payload.durationMs", 0),
        message: optStr(p.message, "payload.message", MAX_TEXT),
    });
}

function logPayload(p: Record<string, unknown>): LogPayload {
    return {
        stage: oneOf(p.stage, STAGES, "payload.stage"),
        level: oneOf(p.level, LOG_LEVELS, "payload.level"),
        message: str(p.message, "payload.message", MAX_LOG_MESSAGE),
    };
}

function findingPayload(p: Record<string, unknown>): FindingPayload {
    return clean({
        ruleId: str(p.ruleId, "payload.ruleId", 200),
        path: str(p.path, "payload.path", MAX_TEXT),
        line: optInt(p.line, "payload.line", 1),
        severity: p.severity === undefined ? undefined : oneOf(p.severity, SEVERITIES, "payload.severity"),
        message: optStr(p.message, "payload.message", MAX_TEXT),
        origin: p.origin === undefined ? undefined : oneOf(p.origin, ORIGINS, "payload.origin"),
    });
}

function progressPayload(p: Record<string, unknown>): ProgressPayload {
    const out: ProgressPayload = { stage: p.stage === undefined ? "review" : oneOf(p.stage, STAGES, "payload.stage") };
    if (p.finder !== undefined) {
        const f = obj(p.finder, "payload.finder");
        out.finder = clean({
            batch: int(f.batch, "payload.finder.batch", 1),
            batches: optInt(f.batches, "payload.finder.batches", 1),
        });
    }
    if (p.candidates !== undefined) {
        out.candidates = int(p.candidates, "payload.candidates", 0);
    }
    if (p.verifier !== undefined) {
        const v = obj(p.verifier, "payload.verifier");
        out.verifier = clean({
            done: int(v.done, "payload.verifier.done", 0),
            total: optInt(v.total, "payload.verifier.total", 0),
        });
    }
    if (!out.finder && out.candidates === undefined && !out.verifier) {
        bad("progress payload needs at least one of finder, candidates, verifier");
    }
    return out;
}

function donePayload(p: Record<string, unknown>): DonePayload {
    if (typeof p.complete !== "boolean") {
        bad("payload.complete must be a boolean");
    }
    const c = obj(p.counts, "payload.counts");
    return clean({
        complete: p.complete,
        status: p.status === undefined ? undefined : oneOf(p.status, RUN_STATUSES, "payload.status"),
        durationMs: optInt(p.durationMs, "payload.durationMs", 0),
        counts: clean({
            findings: int(c.findings, "payload.counts.findings", 0),
            errors: int(c.errors, "payload.counts.errors", 0),
            warnings: int(c.warnings, "payload.counts.warnings", 0),
            candidates: optInt(c.candidates, "payload.counts.candidates", 0),
            verified: optInt(c.verified, "payload.counts.verified", 0),
        }),
    });
}

/**
 * Validate one producer event. `at` may be omitted and is then stamped with `now`; any other missing or
 * wrong field is a 400 (HttpError), never a silent default, matching the /runs contract.
 */
export function parseEvent(raw: unknown, now: Date): LiveEventInput {
    const body = obj(raw, "event");
    const type = oneOf(body.type, EVENT_TYPES, "type");
    const repo = repoName(body.repo);
    const runId = str(body.runId, "runId", MAX_RUN_ID);
    const kind = oneOf(body.kind, KINDS, "kind");
    let at = now.toISOString();
    if (body.at !== undefined) {
        if (typeof body.at !== "string" || Number.isNaN(Date.parse(body.at))) {
            bad("at must be an ISO 8601 timestamp");
        }
        at = new Date(body.at).toISOString();
    }
    const payload = obj(body.payload, "payload");
    const base = { repo, runId, kind, at };
    switch (type) {
        case EVENT_STAGE:
            return { type, ...base, payload: stagePayload(payload) };
        case EVENT_LOG:
            return { type, ...base, payload: logPayload(payload) };
        case EVENT_FINDING:
            return { type, ...base, payload: findingPayload(payload) };
        case EVENT_PROGRESS:
            return { type, ...base, payload: progressPayload(payload) };
        case EVENT_DONE:
            return { type, ...base, payload: donePayload(payload) };
    }
}
