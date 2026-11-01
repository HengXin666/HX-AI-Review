// Envelope encryption for GitHub App secrets and HMAC checks for webhooks. WebCrypto only, so it runs in the
// Worker and under node --test alike.
import { HttpError } from "../http.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Worker secret holding the key-encryption key. Without it nothing secret is stored or read. */
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
