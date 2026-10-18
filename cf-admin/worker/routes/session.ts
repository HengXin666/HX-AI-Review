// POST /api/session and DELETE /api/session. Password comes from Worker vars, not the browser bundle.
import { HttpError, field, readJson } from "../http.ts";
import type { Deps } from "../http.ts";
import { cookieHeader, issueSession, passwordsMatch } from "../session.ts";

const JSON_TYPE = "application/json; charset=utf-8";

function respond(body: unknown, status: number, cookie?: string): Response {
    const headers = new Headers({ "content-type": JSON_TYPE, "cache-control": "no-store" });
    if (cookie) {
        headers.set("set-cookie", cookie);
    }
    return new Response(JSON.stringify(body), { status, headers });
}

export async function handleSession(request: Request, deps: Deps): Promise<Response> {
    const secure = request.url.startsWith("https:");
    if (request.method === "DELETE") {
        return respond({ ok: true }, 200, cookieHeader("", secure, 0));
    }
    if (request.method !== "POST") {
        throw new HttpError(404, "no such admin route");
    }
    const credentials = deps.credentials;
    if (!credentials?.user || !credentials.password) {
        throw new HttpError(403, "console login is not configured");
    }
    const body = await readJson(request);
    const user = field(body, "user");
    const password = field(body, "password");
    if (user !== credentials.user || !(await passwordsMatch(password, credentials.password))) {
        throw new HttpError(401, "unknown user or password");
    }
    const token = await issueSession(credentials, deps.now().getTime());
    return respond({ ok: true, user }, 200, cookieHeader(token, secure));
}
