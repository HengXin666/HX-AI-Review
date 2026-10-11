// Port between the review logic and the model runtime. pi.ts is the real adapter; tests use a fake.
import type { TSchema } from "typebox";
import type { Usage } from "../contract/finding.ts";

export type Role = "finder" | "verifier";

export type ToolSpec = {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    /** Returns the text sent back to the model. */
    execute(params: Record<string, unknown>): string;
};

export type AgentRequest = {
    role: Role;
    model: string;
    system: string;
    prompt: string;
    tools: ToolSpec[];
};

export type AgentResult = {
    usage: Usage;
    /** Session messages, stored as JSONL in R2 for audit. */
    transcript: unknown[];
};

export type AgentRunner = (request: AgentRequest) => Promise<AgentResult>;
