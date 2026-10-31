// GitHub App JWT and webhook signatures. The PEM GitHub issues is PKCS#1; WebCrypto only
// imports PKCS#8, so the key is wrapped here instead of pulling in a JOSE library.

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function der(tag: number, content: Uint8Array): Uint8Array {
    let length: Uint8Array;
    if (content.length < 0x80) {
        length = Uint8Array.from([content.length]);
    } else {
        const bytes: number[] = [];
        let rest = content.length;
        while (rest > 0) {
            bytes.unshift(rest & 0xff);
            rest >>= 8;
        }
        length = Uint8Array.from([0x80 | bytes.length, ...bytes]);
    }
    return concat([Uint8Array.from([tag]), length, content]);
}

/** Wrap a PKCS#1 RSA private key as PKCS#8 so crypto.subtle can import it. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
    const version = Uint8Array.from([0x02, 0x01, 0x00]);
    const algorithm = Uint8Array.from([
        0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
    ]);
    return der(0x30, concat([version, algorithm, der(0x04, pkcs1)]));
}

function pemBytes(pem: string): { kind: "pkcs1" | "pkcs8"; bytes: Uint8Array } {
    const pkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
    const body = pem
        .replace(/-----BEGIN [^-]+-----/g, "")
        .replace(/-----END [^-]+-----/g, "")
        .replace(/\s+/g, "");
    const raw = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
    return { kind: pkcs1 ? "pkcs1" : "pkcs8", bytes: raw };
}

export async function importAppKey(pem: string): Promise<CryptoKey> {
    const parsed = pemBytes(pem);
    const pkcs8 = parsed.kind === "pkcs1" ? pkcs1ToPkcs8(parsed.bytes) : parsed.bytes;
    return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

function b64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/** RS256 JWT, iss = App ID. GitHub rejects a token whose exp is more than 10 minutes out. */
export async function appJwt(appId: number, pem: string, now: Date): Promise<string> {
    const key = await importAppKey(pem);
    const header = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const issued = Math.floor(now.getTime() / 1000);
    const payload = b64url(
        encoder.encode(JSON.stringify({ iat: issued - 60, exp: issued + 9 * 60, iss: String(appId) })),
    );
    const signing = encoder.encode(`${header}.${payload}`);
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, signing));
    return `${header}.${payload}.${b64url(signature)}`;
}

export async function webhookSignature(secret: string, body: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
    ]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
    const hex = [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return "sha256=" + hex;
}

/** Constant-time compare so a bad signature does not leak how far it matched. */
export function signaturesMatch(expected: string, given: string): boolean {
    const a = encoder.encode(expected);
    const b = encoder.encode(given);
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let index = 0; index < a.length; index++) {
        diff |= a[index] ^ b[index];
    }
    return diff === 0;
}
