import { HttpError } from "./http.ts";
import type { Deps } from "./http.ts";
import type { RepoRow } from "./store/port.ts";

const encoder = new TextEncoder();
const TOKEN_PREFIX = "hxctx_";

function base64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export async function sha256Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One HX_CTX_TOKEN per repository; only its SHA-256 is stored in D1. */
export function newToken(): string {
    return TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function repoFromToken(request: Request, deps: Deps): Promise<RepoRow> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token.startsWith(TOKEN_PREFIX)) {
        throw new HttpError(401, "missing or malformed HX_CTX_TOKEN");
    }
    const repo = await deps.store.repoByTokenHash(await sha256Hex(token));
    if (!repo) {
        throw new HttpError(401, "unknown HX_CTX_TOKEN");
    }
    return repo;
}

type Jwk = JsonWebKey & { kid?: string };
let jwksCache: { domain: string; keys: Jwk[]; at: number } | undefined;

async function accessKeys(domain: string): Promise<Jwk[]> {
    if (jwksCache && jwksCache.domain === domain && Date.now() - jwksCache.at < 600_000) {
        return jwksCache.keys;
    }
    const response = await fetch(`https://${domain}/cdn-cgi/access/certs`);
    const body = (await response.json()) as { keys?: Jwk[] };
    jwksCache = { domain, keys: body.keys ?? [], at: Date.now() };
    return jwksCache.keys;
}

/**
 * Verify the Cf-Access-Jwt-Assertion header (RS256) against the team JWKS and audience.
 * Fails closed: with no ACCESS_AUD or team domain configured nobody is an admin.
 */
export async function verifyAccess(request: Request, aud?: string, domain?: string): Promise<string | null> {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token || !aud || !domain) {
        return null;
    }
    const [head, payload, signature] = token.split(".");
    if (!head || !payload || !signature) {
        return null;
    }
    const header = JSON.parse(new TextDecoder().decode(fromBase64url(head))) as { kid?: string; alg?: string };
    const jwk = (await accessKeys(domain)).find((key) => key.kid === header.kid);
    if (!jwk || header.alg !== "RS256") {
        return null;
    }
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "verify",
    ]);
    const valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        fromBase64url(signature),
        encoder.encode(head + "." + payload),
    );
    if (!valid) {
        return null;
    }
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as {
        aud?: string | string[];
        exp?: number;
        email?: string;
    };
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(aud) || !claims.exp || claims.exp * 1000 < Date.now()) {
        return null;
    }
    return claims.email ?? "access-user";
}

export async function requireAdmin(request: Request, deps: Deps): Promise<string> {
    const who = await deps.admin(request);
    if (!who) {
        throw new HttpError(403, "Cloudflare Access identity required");
    }
    return who;
}
