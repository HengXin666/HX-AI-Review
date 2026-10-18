// Console session for the overview. Credentials live in Worker vars, never in the Pages bundle.
import type { Credentials } from "./http.ts";

const COOKIE = "hxctx_admin";
const MAX_AGE = 12 * 60 * 60;
const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function hmac(password: string, payload: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

function same(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) {
        return false;
    }
    let diff = 0;
    for (let index = 0; index < left.length; index++) {
        diff |= left[index]! ^ right[index]!;
    }
    return diff === 0;
}

/** Compare digests so the check does not stop at the first differing character. */
export async function passwordsMatch(given: string, expected: string): Promise<boolean> {
    const digest = (text: string) => crypto.subtle.digest("SHA-256", encoder.encode("hxctx:" + text));
    return same(new Uint8Array(await digest(given)), new Uint8Array(await digest(expected)));
}

export async function issueSession(credentials: Credentials, nowMs: number): Promise<string> {
    const payload = `${credentials.user}\n${nowMs + MAX_AGE * 1000}`;
    const signature = await hmac(credentials.password, payload);
    return b64url(encoder.encode(payload)) + "." + b64url(signature);
}

export function cookieHeader(token: string, secure: boolean, maxAge = MAX_AGE): string {
    const parts = [`${COOKIE}=${token}`, "HttpOnly", "Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
    if (secure) {
        parts.push("Secure");
    }
    return parts.join("; ");
}

function cookieValue(header: string): string | undefined {
    return header
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(COOKIE + "="))
        ?.slice(COOKIE.length + 1);
}

/** Access is preferred; this is the fallback when ADMIN_USER and ADMIN_PASSWORD are set on the Worker. */
export async function sessionUser(
    request: Request,
    credentials: Credentials | undefined,
    nowMs: number,
): Promise<string | null> {
    if (!credentials?.user || !credentials.password) {
        return null;
    }
    const token = cookieValue(request.headers.get("cookie") ?? "");
    const dot = token?.indexOf(".") ?? -1;
    if (!token || dot <= 0) {
        return null;
    }
    let payload: string;
    let given: Uint8Array;
    try {
        payload = new TextDecoder().decode(fromB64url(token.slice(0, dot)));
        given = fromB64url(token.slice(dot + 1));
    } catch {
        return null;
    }
    if (!same(given, await hmac(credentials.password, payload))) {
        return null;
    }
    const split = payload.indexOf("\n");
    const user = split < 0 ? "" : payload.slice(0, split);
    const exp = Number(split < 0 ? "" : payload.slice(split + 1));
    if (user !== credentials.user || !Number.isFinite(exp) || exp < nowMs) {
        return null;
    }
    return user;
}
