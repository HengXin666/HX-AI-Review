// GitHub App JWT (RS256). GitHub hands out PKCS#1 PEMs; WebCrypto only imports PKCS#8, so PKCS#1 is wrapped here.
import { HttpError } from "../http.ts";
import { b64url, b64urlText, unb64 } from "./crypto.ts";

const encoder = new TextEncoder();
const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
/** AlgorithmIdentifier for rsaEncryption with NULL parameters. */
const RSA_ALGORITHM_ID = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
/** GitHub accepts exp at most 10 minutes ahead; iat is backdated 60 s for clock drift. */
export const JWT_BACKDATE_S = 60;
export const JWT_LIFETIME_S = 540;

function derLength(length: number): number[] {
    if (length < 0x80) {
        return [length];
    }
    const bytes: number[] = [];
    while (length > 0) {
        bytes.unshift(length & 0xff);
        length >>= 8;
    }
    return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
    const head = [tag, ...derLength(content.length)];
    const out = new Uint8Array(head.length + content.length);
    out.set(head);
    out.set(content, head.length);
    return out;
}

/** PrivateKeyInfo { version 0, rsaEncryption, OCTET STRING pkcs1 }. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
    const version = [0x02, 0x01, 0x00];
    const octet = tlv(0x04, pkcs1);
    const inner = new Uint8Array(version.length + RSA_ALGORITHM_ID.length + octet.length);
    inner.set(version);
    inner.set(RSA_ALGORITHM_ID, version.length);
    inner.set(octet, version.length + RSA_ALGORITHM_ID.length);
    return tlv(0x30, inner);
}

export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
    const pkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
    if (!pkcs1 && !pem.includes("BEGIN PRIVATE KEY")) {
        throw new HttpError(400, "privateKey must be a PEM private key (BEGIN RSA PRIVATE KEY or BEGIN PRIVATE KEY)");
    }
    const body = pem.replace(/-----(BEGIN|END)[A-Z ]+-----/g, "").replace(/\s+/g, "");
    let der: Uint8Array<ArrayBuffer>;
    try {
        der = unb64(body);
    } catch {
        throw new HttpError(400, "privateKey PEM body is not valid base64");
    }
    return pkcs1 ? pkcs1ToPkcs8(der) : der;
}

export async function importAppKey(pem: string): Promise<CryptoKey> {
    const der = pemToPkcs8(pem);
    try {
        return await crypto.subtle.importKey("pkcs8", der, ALGORITHM, false, ["sign"]);
    } catch {
        throw new HttpError(400, "privateKey is not a valid RSA private key");
    }
}

/** App JWT: iat = now - 60 s, exp = iat + 600 s = now + 9 min, iss = app id. */
export async function appJwt(pem: string, appId: string, now: Date): Promise<string> {
    const key = await importAppKey(pem);
    const iat = Math.floor(now.getTime() / 1000) - JWT_BACKDATE_S;
    const exp = iat + JWT_BACKDATE_S + JWT_LIFETIME_S;
    const signed =
        b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
        "." +
        b64urlText(JSON.stringify({ iat, exp, iss: appId }));
    const signature = await crypto.subtle.sign(ALGORITHM.name, key, encoder.encode(signed));
    return signed + "." + b64url(new Uint8Array(signature));
}
