// Operator prompt versions. Rejection notes fold into the next active addendum; they never become Errors.
import { HttpError, field, json, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import type { PromptNote, PromptRole, PromptVersion } from "../store/port.ts";

const MAX_BODY = 4000;

function bytes(text: string): number {
    return new TextEncoder().encode(text).length;
}

export function roleOf(value: unknown): PromptRole {
    if (value === "finder" || value === "verifier") {
        return value;
    }
    throw new HttpError(400, "role must be finder or verifier");
}

/** Append unfolded rejection reasons under the current addendum. The built-in system prompt stays in the runner. */
export function foldedBody(active: string, notes: Pick<PromptNote, "fingerprint" | "reason">[]): string {
    const block = notes.map((note) => `- ${note.fingerprint}: ${note.reason}`).join("\n");
    const section = "Do not repeat these rejected claims:\n" + block;
    const body = active ? active.trimEnd() + "\n\n" + section : section;
    if (bytes(body) > MAX_BODY) {
        throw new HttpError(400, `folded prompt exceeds ${MAX_BODY} bytes; publish a shorter addendum first`);
    }
    return body;
}

function checkBody(body: string): string {
    if (!body.trim()) {
        throw new HttpError(400, "body must be a nonempty string");
    }
    if (bytes(body) > MAX_BODY) {
        throw new HttpError(400, `body must be at most ${MAX_BODY} bytes`);
    }
    return body;
}

export async function handlePrompts(request: Request, deps: Deps, rest: string[]): Promise<Response> {
    if (request.method === "GET" && rest.length === 0) {
        const [versions, notes] = await Promise.all([deps.store.listPromptVersions(), deps.store.listPromptNotes(50)]);
        return json({ versions, notes });
    }
    const body = await readJson(request);
    const role = roleOf(body.role);
    if (request.method === "POST" && rest.length === 0) {
        const published = await deps.store.publishPrompt(role, checkBody(field(body, "body")), String(body.note ?? ""));
        return json({ version: published }, 201);
    }
    if (request.method === "POST" && rest[0] === "fold") {
        const notes = (await deps.store.listPromptNotes(50)).filter((note) => note.foldedInto === null);
        if (!notes.length) {
            throw new HttpError(400, "no unfolded rejection notes");
        }
        const active = (await deps.store.activePrompts()).find((item) => item.role === role);
        const published: PromptVersion = await deps.store.publishPrompt(
            role,
            foldedBody(active?.body ?? "", notes),
            "folded rejection notes",
        );
        await deps.store.foldNotes(
            notes.map((note) => note.id),
            published.id,
        );
        return json({ version: published, folded: notes.length }, 201);
    }
    throw new HttpError(404, "no such admin route");
}
