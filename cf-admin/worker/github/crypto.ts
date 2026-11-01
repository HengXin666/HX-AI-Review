// Envelope encryption for GitHub App secrets and HMAC checks for webhooks. WebCrypto only, so it runs in the
// Worker and under node --test alike.
import { HttpError } from "../http.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The NAME of the Worker secret that holds the key-encryption key, not the key itself: the value is read from
 * env at run time and never appears in the source. Without that secret nothing secret is stored or read.
 */
// skipcq: SCT-A000 - this is the secret's name, which must be a literal to be looked up.
export const KEK_SECRET = "GITHUB_APP_KEK";
const ENVELOPE_VERSION = "v1";

export function b64(bytes: Uint8Array): string {
    let text = "";
    for (const byte of bytes) {
        text += String.fromCharCode(byte);
    }
    return btoa(text);
}

export function unb64(text: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export function b64url(bytes: Uint8Array): string {
    return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlText(text: string): string {
    return b64url(encoder.encode(text));
}

/** The KEK, or a readable 400: a missing secret must never degrade to storing plaintext. */
export function requireKek(secret: (name: string) => string | undefined): string {
    const value = secret(KEK_SECRET);
    if (!value) {
        throw new HttpError(
            400,
            `Worker secret ${KEK_SECRET} is not set; GitHub App credentials cannot be stored or read`,
        );
    }
    return value;
}

async function kekKey(kek: string): Promise<CryptoKey> {
    const raw = await crypto.subtle.digest("SHA-256", encoder.encode(kek));
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * AES-GCM envelope: a fresh 256-bit data key encrypts the value, the KEK (Worker secret) encrypts the data key.
 * Result: v1.<wrap iv>.<wrapped data key>.<iv>.<ciphertext>, all base64. Only this string ever reaches D1.
 */
export async function seal(plaintext: string, kek: string): Promise<string> {
    const dataKey = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const valueKey = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, valueKey, encoder.encode(plaintext));
    const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, await kekKey(kek), dataKey);
    dataKey.fill(0);
    return [ENVELOPE_VERSION, b64(wrapIv), b64(new Uint8Array(wrapped)), b64(iv), b64(new Uint8Array(ciphertext))].join(
        ".",
    );
}

/** Inverse of seal. A wrong KEK or a tampered envelope throws instead of returning garbage. */
export async function unseal(envelope: string, kek: string): Promise<string> {
    const parts = envelope.split(".");
    if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
        throw new Error("unsupported secret envelope");
    }
    const [, wrapIv, wrapped, iv, ciphertext] = parts;
    const dataKey = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(wrapIv) },
        await kekKey(kek),
        unb64(wrapped),
    );
    const valueKey = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, valueKey, unb64(ciphertext));
    return decoder.decode(plain);
}

/**
 * Check X-Hub-Signature-256 ("sha256=<hex>") over the raw body. crypto.subtle.verify does the MAC comparison
 * in constant time, so no hand-written string compare leaks timing.
 */
export async function verifyWebhookSignature(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null) {
    if (!header || !header.startsWith("sha256=")) {
        return false;
    }
    const hex = header.slice(7);
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        return false;
    }
    const signature = new Uint8Array(32);
    for (let index = 0; index < 32; index++) {
        signature[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "verify",
    ]);
    return crypto.subtle.verify("HMAC", key, signature, body);
}

// GitHub App JWT and webhook signatures. The PEM GitHub issues is PKCS#1; WebCrypto only
// imports PKCS#8, so the key is wrapped here instead of pulling in a JOSE library.

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
