// Live run stream: frame types for /api/live and a WebSocket client that reconnects, answers heartbeats and resumes.
//
// The shapes mirror cf-admin/worker/realtime/events.ts, which is the authority; field names must not be renamed here.
// Downstream frames are the five producer events (stage, log, finding, progress, done), each with a per-repo strictly
// increasing top-level "id", plus two server-only control frames: "snapshot" (always the first frame on a connection)
// and "ping" (every 30 s; the client must answer {"type":"pong"} or the server closes the socket with 4000 after 90 s).
// Resume cursor: the event "id" (never "at"); the client reconnects with ?lastEventId=<id>.

import type { Kind } from "./api.ts";

/** The six pipeline stages, in run order. The stage bar always shows all six. */
export const LIVE_STAGES = ["init", "l0", "rules", "scope", "review", "publish"] as const;
export type LiveStage = (typeof LIVE_STAGES)[number];

export const STAGE_STATUSES = ["running", "done", "failed"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const SEVERITIES = ["error", "warning"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const ORIGINS = ["new", "historical"] as const;
export type Origin = (typeof ORIGINS)[number];
export const RUN_STATUSES = ["passed", "warned", "failed", "skipped", "incomplete"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type StagePayload = { stage: LiveStage; status: StageStatus; durationMs?: number; message?: string };
export type LogPayload = { stage: LiveStage; level: LogLevel; message: string };
export type FindingPayload = {
    ruleId: string;
    path: string;
    line?: number;
    severity?: Severity;
    message?: string;
    origin?: Origin;
};
export type ProgressPayload = {
    stage: LiveStage;
    finder?: { batch: number; batches?: number };
    candidates?: number;
    verifier?: { done: number; total?: number };
};
export type DoneCounts = { findings: number; errors: number; warnings: number; candidates?: number; verified?: number };
export type DonePayload = { complete: boolean; status?: RunStatus; durationMs?: number; counts: DoneCounts };

/** Fields every event carries. "at" is an ISO timestamp; "id" is the per-repo resume cursor. */
export type LiveBase = { id: number; repo: string; runId: string; kind: Kind; at: string };

export type StageEvent = LiveBase & { type: "stage"; payload: StagePayload };
export type LogEvent = LiveBase & { type: "log"; payload: LogPayload };
export type FindingEvent = LiveBase & { type: "finding"; payload: FindingPayload };
export type ProgressEvent = LiveBase & { type: "progress"; payload: ProgressPayload };
export type DoneEvent = LiveBase & { type: "done"; payload: DonePayload };

export type LiveEvent = StageEvent | LogEvent | FindingEvent | ProgressEvent | DoneEvent;

/** One run the hub believes is in flight. */
export type ActiveRun = {
    runId: string;
    kind: Kind;
    stage: LiveStage | null;
    status: StageStatus | null;
    startedAt: string;
    updatedAt: string;
    lastEventId: number;
};

export type SnapshotFrame = {
    type: "snapshot";
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
        /** True when the resume point is gone from the buffer: local incremental state must be dropped. */
        gap: boolean;
    };
};

export type PingFrame = { type: "ping"; at: string };

/** Everything the server may send down the socket. */
export type LiveFrame = LiveEvent | SnapshotFrame | PingFrame;

/** Connection state as the page shows it. "unavailable" means the handshake keeps failing before it ever opens. */
export type LiveStatus = "connecting" | "open" | "reconnecting" | "unavailable" | "closed";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function int(value: unknown, min: number): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
    return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isKind(value: unknown): value is Kind {
    return value === "context" || value === "code";
}

/** An optional field is valid when it is absent or passes its check. */
function opt(value: unknown, check: (value: unknown) => boolean): boolean {
    return value === undefined || check(value);
}

function stagePayload(p: Record<string, unknown>): StagePayload | null {
    if (!oneOf(p.stage, LIVE_STAGES) || !oneOf(p.status, STAGE_STATUSES)) {
        return null;
    }
    if (!opt(p.durationMs, (v) => int(v, 0)) || !opt(p.message, str)) {
        return null;
    }
    const out: StagePayload = { stage: p.stage, status: p.status };
    if (p.durationMs !== undefined) {
        out.durationMs = p.durationMs as number;
    }
    if (p.message !== undefined) {
        out.message = p.message as string;
    }
    return out;
}

function logPayload(p: Record<string, unknown>): LogPayload | null {
    if (!oneOf(p.stage, LIVE_STAGES) || !oneOf(p.level, LOG_LEVELS) || !str(p.message)) {
        return null;
    }
    return { stage: p.stage, level: p.level, message: p.message };
}

function findingPayload(p: Record<string, unknown>): FindingPayload | null {
    if (!str(p.ruleId) || !str(p.path)) {
        return null;
    }
    if (
        !opt(p.line, (v) => int(v, 1)) ||
        !opt(p.severity, (v) => oneOf(v, SEVERITIES)) ||
        !opt(p.message, str) ||
        !opt(p.origin, (v) => oneOf(v, ORIGINS))
    ) {
        return null;
    }
    const out: FindingPayload = { ruleId: p.ruleId, path: p.path };
    if (p.line !== undefined) {
        out.line = p.line as number;
    }
    if (p.severity !== undefined) {
        out.severity = p.severity as Severity;
    }
    if (p.message !== undefined) {
        out.message = p.message as string;
    }
    if (p.origin !== undefined) {
        out.origin = p.origin as Origin;
    }
    return out;
}

function progressPayload(p: Record<string, unknown>): ProgressPayload | null {
    if (!oneOf(p.stage, LIVE_STAGES)) {
        return null;
    }
    const out: ProgressPayload = { stage: p.stage };
    if (p.finder !== undefined) {
        const f = p.finder;
        if (!isRecord(f) || !int(f.batch, 1) || !opt(f.batches, (v) => int(v, 1))) {
            return null;
        }
        out.finder = f.batches === undefined ? { batch: f.batch } : { batch: f.batch, batches: f.batches as number };
    }
    if (p.candidates !== undefined) {
        if (!int(p.candidates, 0)) {
            return null;
        }
        out.candidates = p.candidates;
    }
    if (p.verifier !== undefined) {
        const v = p.verifier;
        if (!isRecord(v) || !int(v.done, 0) || !opt(v.total, (x) => int(x, 0))) {
            return null;
        }
        out.verifier = v.total === undefined ? { done: v.done } : { done: v.done, total: v.total as number };
    }
    if (!out.finder && out.candidates === undefined && !out.verifier) {
        return null;
    }
    return out;
}

function donePayload(p: Record<string, unknown>): DonePayload | null {
    const c = p.counts;
    if (typeof p.complete !== "boolean" || !isRecord(c)) {
        return null;
    }
    if (!int(c.findings, 0) || !int(c.errors, 0) || !int(c.warnings, 0)) {
        return null;
    }
    if (!opt(c.candidates, (v) => int(v, 0)) || !opt(c.verified, (v) => int(v, 0))) {
        return null;
    }
    if (!opt(p.status, (v) => oneOf(v, RUN_STATUSES)) || !opt(p.durationMs, (v) => int(v, 0))) {
        return null;
    }
    const counts: DoneCounts = { findings: c.findings, errors: c.errors, warnings: c.warnings };
    if (c.candidates !== undefined) {
        counts.candidates = c.candidates as number;
    }
    if (c.verified !== undefined) {
        counts.verified = c.verified as number;
    }
    const out: DonePayload = { complete: p.complete, counts };
    if (p.status !== undefined) {
        out.status = p.status as RunStatus;
    }
    if (p.durationMs !== undefined) {
        out.durationMs = p.durationMs as number;
    }
    return out;
}

function activeRun(value: unknown): ActiveRun | null {
    if (!isRecord(value)) {
        return null;
    }
    const { runId, kind, stage, status, startedAt, updatedAt, lastEventId } = value;
    if (!str(runId) || !isKind(kind) || !str(startedAt) || !str(updatedAt) || !int(lastEventId, 0)) {
        return null;
    }
    if (!(stage === null || oneOf(stage, LIVE_STAGES)) || !(status === null || oneOf(status, STAGE_STATUSES))) {
        return null;
    }
    return { runId, kind, stage, status, startedAt, updatedAt, lastEventId };
}

function snapshotFrame(value: Record<string, unknown>): SnapshotFrame | null {
    const p = value.payload;
    if (!str(value.repo) || !str(value.at) || !isRecord(p) || !Array.isArray(p.runs)) {
        return null;
    }
    if (!int(p.lastEventId, 0) || !int(p.oldestEventId, 0) || !int(p.replayed, 0) || typeof p.gap !== "boolean") {
        return null;
    }
    const runs: ActiveRun[] = [];
    for (const item of p.runs) {
        const run = activeRun(item);
        if (!run) {
            return null;
        }
        runs.push(run);
    }
    return {
        type: "snapshot",
        repo: value.repo,
        at: value.at,
        payload: {
            runs,
            lastEventId: p.lastEventId,
            oldestEventId: p.oldestEventId,
            replayed: p.replayed,
            gap: p.gap,
        },
    };
}

/**
 * Parse one producer event. A frame that does not match the contract is dropped, never coerced: inventing a
 * default would show the user data the runner never sent. Optional payload fields stay optional.
 */
export function parseLiveEvent(value: unknown): LiveEvent | null {
    if (!isRecord(value) || !isRecord(value.payload)) {
        return null;
    }
    const { id, type, repo, runId, kind, at, payload: p } = value;
    if (!int(id, 1) || !str(repo) || !str(runId) || !str(at) || !isKind(kind)) {
        return null;
    }
    const base: LiveBase = { id, repo, runId, kind, at };
    switch (type) {
        case "stage": {
            const payload = stagePayload(p);
            return payload ? { ...base, type, payload } : null;
        }
        case "log": {
            const payload = logPayload(p);
            return payload ? { ...base, type, payload } : null;
        }
        case "finding": {
            const payload = findingPayload(p);
            return payload ? { ...base, type, payload } : null;
        }
        case "progress": {
            const payload = progressPayload(p);
            return payload ? { ...base, type, payload } : null;
        }
        case "done": {
            const payload = donePayload(p);
            return payload ? { ...base, type, payload } : null;
        }
        default:
            return null;
    }
}

/** Parse any downstream frame: one of the five events, a snapshot or a ping. Anything else is dropped. */
export function parseLiveFrame(raw: string): LiveFrame | null {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isRecord(value)) {
        return null;
    }
    if (value.type === "snapshot") {
        return snapshotFrame(value);
    }
    if (value.type === "ping") {
        return { type: "ping", at: str(value.at) ? value.at : "" };
    }
    return parseLiveEvent(value);
}

/** ws:// or wss:// URL for one repo on the current origin, with the resume cursor when there is one. */
export function liveUrl(repo: string, lastEventId: number | null): string {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams({ repo });
    if (lastEventId !== null && lastEventId > 0) {
        query.set("lastEventId", String(lastEventId));
    }
    return `${scheme}//${window.location.host}/api/live?${query.toString()}`;
}

export type LiveHandlers = {
    onEvent: (event: LiveEvent) => void;
    /** First frame of every (re)connection: the active runs of the room, and whether local state must be dropped. */
    onSnapshot: (frame: SnapshotFrame) => void;
    onStatus: (status: LiveStatus, attempt: number) => void;
};

/** Handshake failures in a row, without ever opening, after which the endpoint is reported as not ready. */
const UNAVAILABLE_AFTER = 3;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const PONG = JSON.stringify({ type: "pong" });

/**
 * Subscribe to one repo (the server allows exactly one per socket). Answers every ping with a pong, reconnects
 * with exponential backoff and resumes from the last event id. Returns a function that closes the socket.
 */
export function connectLive(repo: string, handlers: LiveHandlers): () => void {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cursor: number | null = null;
    let attempt = 0;
    let failedHandshakes = 0;
    let stopped = false;

    const schedule = () => {
        if (stopped) {
            return;
        }
        attempt += 1;
        const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(attempt - 1, 5));
        handlers.onStatus(failedHandshakes >= UNAVAILABLE_AFTER ? "unavailable" : "reconnecting", attempt);
        timer = setTimeout(open, delay);
    };

    const open = () => {
        timer = null;
        if (stopped) {
            return;
        }
        let opened = false;
        handlers.onStatus(attempt === 0 ? "connecting" : "reconnecting", attempt);
        let ws: WebSocket;
        try {
            ws = new WebSocket(liveUrl(repo, cursor));
        } catch {
            failedHandshakes += 1;
            schedule();
            return;
        }
        socket = ws;
        ws.onopen = () => {
            opened = true;
            attempt = 0;
            failedHandshakes = 0;
            handlers.onStatus("open", 0);
        };
        ws.onmessage = (message) => {
            if (typeof message.data !== "string") {
                return;
            }
            const frame = parseLiveFrame(message.data);
            if (!frame) {
                return;
            }
            if (frame.type === "ping") {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(PONG);
                }
                return;
            }
            if (frame.type === "snapshot") {
                // With nothing replayed the snapshot is the whole state, so its newest id is the cursor.
                // With a replay, the replayed events that follow advance the cursor one by one.
                if (frame.payload.gap || frame.payload.replayed === 0) {
                    cursor = frame.payload.lastEventId;
                }
                handlers.onSnapshot(frame);
                return;
            }
            if (cursor === null || frame.id > cursor) {
                cursor = frame.id;
            }
            handlers.onEvent(frame);
        };
        ws.onclose = () => {
            socket = null;
            if (!opened) {
                failedHandshakes += 1;
            }
            schedule();
        };
        // onerror is always followed by onclose, which owns the reconnect.
        ws.onerror = () => undefined;
    };

    open();

    return () => {
        stopped = true;
        if (timer) {
            clearTimeout(timer);
        }
        if (socket) {
            socket.onclose = null;
            socket.close();
            socket = null;
        }
        handlers.onStatus("closed", 0);
    };
}
