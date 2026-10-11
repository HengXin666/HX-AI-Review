// Port between the review logic and the model runtime. pi.ts is the real adapter; tests use a fake.
import type { TSchema } from "typebox";
import type { Usage } from "../contract/finding.ts";

export type Role = "finder" | "verifier";

export type ToolSpec = {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    /**
     * Returns the text sent back to the model. Async so a slow git call cannot block the session timer,
     * and given the session's abort signal so a cancelled session also kills an in-flight git command.
     */
    execute(params: Record<string, unknown>, signal?: AbortSignal): string | Promise<string>;
};

export type AgentRequest = {
    role: Role;
    model: string;
    system: string;
    prompt: string;
    tools: ToolSpec[];
    /** Wall-clock limit for this session; the runner aborts and throws a SessionError past it. */
    timeoutMs: number;
};

export type AgentResult = {
    usage: Usage;
    /** Session messages, stored as JSONL in R2 for audit. */
    transcript: unknown[];
};

export type AgentRunner = (request: AgentRequest) => Promise<AgentResult>;

/** A session that failed after spending tokens: the usage still counts and the transcript is still stored. */
export class SessionError extends Error {
    readonly partial: AgentResult;

    constructor(message: string, partial: AgentResult) {
        super(message);
        this.partial = partial;
    }
}
