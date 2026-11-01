// libsodium crypto_box_seal in plain TypeScript, for GitHub Actions secrets (PUT /repos/{repo}/actions/secrets/*).
// Workers have no libsodium and WebCrypto has no XSalsa20-Poly1305, so the four primitives are written out here:
// X25519 (RFC 7748), HSalsa20/XSalsa20, Poly1305 (RFC 8439 arithmetic) and BLAKE2b (RFC 7693, nonce derivation).
// It only ever seals one short secret per request, so BigInt arithmetic is fast enough and keeps the code readable.
// Wire format, as libsodium: ephemeral_pk (32) || MAC (16) || ciphertext, nonce = BLAKE2b-192(ephemeral_pk || pk).

const P = (1n << 255n) - 19n;
const A24 = 121665n;

function mod(value: bigint, m: bigint = P): bigint {
    const r = value % m;
    return r >= 0n ? r : r + m;
}

function powMod(base: bigint, exp: bigint): bigint {
    let result = 1n;
    let b = mod(base);
    let e = exp;
    while (e > 0n) {
        if (e & 1n) {
            result = mod(result * b);
        }
        b = mod(b * b);
        e >>= 1n;
    }
    return result;
}

function leToBig(bytes: Uint8Array): bigint {
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index--) {
        value = (value << 8n) | BigInt(bytes[index]);
    }
    return value;
}

function bigToLe(value: bigint, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let v = value;
    for (let index = 0; index < length; index++) {
        out[index] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}

/** X25519(k, u) per RFC 7748 section 5 (Montgomery ladder). */
export function x25519(scalar: Uint8Array, point: Uint8Array): Uint8Array {
    const k = Uint8Array.from(scalar);
    k[0] &= 248;
    k[31] &= 127;
    k[31] |= 64;
    const kn = leToBig(k);
    const u = Uint8Array.from(point);
    u[31] &= 127;
    const x1 = mod(leToBig(u));
    let x2 = 1n;
    let z2 = 0n;
    let x3 = x1;
    let z3 = 1n;
    let swap = 0n;
    for (let t = 254n; t >= 0n; t--) {
        const bit = (kn >> t) & 1n;
        swap ^= bit;
        if (swap) {
            [x2, x3] = [x3, x2];
            [z2, z3] = [z3, z2];
        }
        swap = bit;
        const a = mod(x2 + z2);
        const aa = mod(a * a);
        const b = mod(x2 - z2);
        const bb = mod(b * b);
        const e = mod(aa - bb);
        const c = mod(x3 + z3);
        const d = mod(x3 - z3);
        const da = mod(d * a);
        const cb = mod(c * b);
        x3 = mod((da + cb) ** 2n);
        z3 = mod(x1 * mod((da - cb) ** 2n));
        x2 = mod(aa * bb);
        z2 = mod(e * mod(aa + A24 * e));
    }
    if (swap) {
        [x2, x3] = [x3, x2];
        [z2, z3] = [z3, z2];
    }
    return bigToLe(mod(x2 * powMod(z2, P - 2n)), 32);
}

const BASE_POINT = (() => {
    const point = new Uint8Array(32);
    point[0] = 9;
    return point;
})();

export function x25519Public(secretKey: Uint8Array): Uint8Array {
    return x25519(secretKey, BASE_POINT);
}

// ---- Salsa20 family -------------------------------------------------------------------------------------------

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

function rotl(value: number, shift: number): number {
    return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function u32(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function salsaState(key: Uint8Array, input: Uint8Array): number[] {
    return [
        SIGMA[0],
        u32(key, 0),
        u32(key, 4),
        u32(key, 8),
        u32(key, 12),
        SIGMA[1],
        u32(input, 0),
        u32(input, 4),
        u32(input, 8),
        u32(input, 12),
        SIGMA[2],
        u32(key, 16),
        u32(key, 20),
        u32(key, 24),
        u32(key, 28),
        SIGMA[3],
    ];
}

function salsaRounds(state: number[]): number[] {
    const x = state.slice();
    const qr = (a: number, b: number, c: number, d: number) => {
        x[b] ^= rotl((x[a] + x[d]) >>> 0, 7);
        x[c] ^= rotl((x[b] + x[a]) >>> 0, 9);
        x[d] ^= rotl((x[c] + x[b]) >>> 0, 13);
        x[a] ^= rotl((x[d] + x[c]) >>> 0, 18);
    };
    for (let round = 0; round < 10; round++) {
        qr(0, 4, 8, 12);
        qr(5, 9, 13, 1);
        qr(10, 14, 2, 6);
        qr(15, 3, 7, 11);
        qr(0, 1, 2, 3);
        qr(5, 6, 7, 4);
        qr(10, 11, 8, 9);
        qr(15, 12, 13, 14);
    }
    return x.map((value) => value >>> 0);
}

function putU32(out: Uint8Array, offset: number, value: number) {
    out[offset] = value & 0xff;
    out[offset + 1] = (value >>> 8) & 0xff;
    out[offset + 2] = (value >>> 16) & 0xff;
    out[offset + 3] = (value >>> 24) & 0xff;
}

/** HSalsa20: derives a subkey from key and a 16-byte input (no feed-forward). */
export function hsalsa20(key: Uint8Array, input: Uint8Array): Uint8Array {
    const x = salsaRounds(salsaState(key, input));
    const out = new Uint8Array(32);
    [0, 5, 10, 15, 6, 7, 8, 9].forEach((word, index) => putU32(out, index * 4, x[word]));
    return out;
}

/** XSalsa20 keystream XOR: HSalsa20 on nonce[0..16], then Salsa20 with nonce[16..24] and a 64-bit counter. */
export function xsalsa20Xor(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Uint8Array {
    const subkey = hsalsa20(key, nonce.subarray(0, 16));
    const out = new Uint8Array(data.length);
    const block = new Uint8Array(16);
    block.set(nonce.subarray(16, 24), 0);
    for (let offset = 0, counter = 0; offset < data.length; offset += 64, counter++) {
        putU32(block, 8, counter);
        putU32(block, 12, Math.floor(counter / 0x100000000));
        const state = salsaState(subkey, block);
        const mixed = salsaRounds(state);
        const stream = new Uint8Array(64);
        for (let word = 0; word < 16; word++) {
            putU32(stream, word * 4, (mixed[word] + state[word]) >>> 0);
        }
        for (let index = 0; index < 64 && offset + index < data.length; index++) {
            out[offset + index] = data[offset + index] ^ stream[index];
        }
    }
    return out;
}

// ---- Poly1305 ---------------------------------------------------------------------------------------------------

const P1305 = (1n << 130n) - 5n;

export function poly1305(key: Uint8Array, message: Uint8Array): Uint8Array {
    const r = leToBig(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
    const s = leToBig(key.subarray(16, 32));
    let acc = 0n;
    for (let offset = 0; offset < message.length; offset += 16) {
        const chunk = message.subarray(offset, Math.min(offset + 16, message.length));
        const n = leToBig(chunk) + (1n << BigInt(8 * chunk.length));
        acc = ((acc + n) * r) % P1305;
    }
    return bigToLe((acc + s) & ((1n << 128n) - 1n), 16);
}

// ---- BLAKE2b ----------------------------------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;
const B2B_IV = [
    0x6a09e667f3bcc908n,
    0xbb67ae8584caa73bn,
    0x3c6ef372fe94f82bn,
    0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n,
    0x9b05688c2b3e6c1fn,
    0x1f83d9abfb41bd6bn,
    0x5be0cd19137e2179n,
];
const SIGMA_B2B = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

function rotr64(value: bigint, shift: bigint): bigint {
    return ((value >> shift) | (value << (64n - shift))) & MASK64;
}

/** Unkeyed BLAKE2b with an outLength-byte digest (1..64). */
export function blake2b(input: Uint8Array, outLength: number): Uint8Array {
    const h = B2B_IV.slice();
    h[0] ^= 0x01010000n ^ BigInt(outLength);
    const blocks = Math.max(1, Math.ceil(input.length / 128));
    for (let blockIndex = 0; blockIndex < blocks; blockIndex++) {
        const last = blockIndex === blocks - 1;
        const block = new Uint8Array(128);
        block.set(input.subarray(blockIndex * 128, Math.min((blockIndex + 1) * 128, input.length)));
        const m: bigint[] = [];
        for (let word = 0; word < 16; word++) {
            m.push(leToBig(block.subarray(word * 8, word * 8 + 8)));
        }
        const counter = BigInt(last ? input.length : (blockIndex + 1) * 128);
        const v = [...h, ...B2B_IV];
        v[12] ^= counter & MASK64;
        v[13] ^= counter >> 64n;
        if (last) {
            v[14] ^= MASK64;
        }
        const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
            v[a] = (v[a] + v[b] + x) & MASK64;
            v[d] = rotr64(v[d] ^ v[a], 32n);
            v[c] = (v[c] + v[d]) & MASK64;
            v[b] = rotr64(v[b] ^ v[c], 24n);
            v[a] = (v[a] + v[b] + y) & MASK64;
            v[d] = rotr64(v[d] ^ v[a], 16n);
            v[c] = (v[c] + v[d]) & MASK64;
            v[b] = rotr64(v[b] ^ v[c], 63n);
        };
        for (let round = 0; round < 12; round++) {
            const s = SIGMA_B2B[round % 10];
            g(0, 4, 8, 12, m[s[0]], m[s[1]]);
            g(1, 5, 9, 13, m[s[2]], m[s[3]]);
            g(2, 6, 10, 14, m[s[4]], m[s[5]]);
            g(3, 7, 11, 15, m[s[6]], m[s[7]]);
            g(0, 5, 10, 15, m[s[8]], m[s[9]]);
            g(1, 6, 11, 12, m[s[10]], m[s[11]]);
            g(2, 7, 8, 13, m[s[12]], m[s[13]]);
            g(3, 4, 9, 14, m[s[14]], m[s[15]]);
        }
        for (let index = 0; index < 8; index++) {
            h[index] ^= v[index] ^ v[index + 8];
        }
    }
    const out = new Uint8Array(64);
    h.forEach((word, index) => out.set(bigToLe(word, 8), index * 8));
    return out.slice(0, outLength);
}

// ---- crypto_box / crypto_box_seal ---------------------------------------------------------------------------------

/** crypto_secretbox (XSalsa20-Poly1305): returns MAC (16) || ciphertext. */
export function secretbox(message: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
    const padded = new Uint8Array(32 + message.length);
    padded.set(message, 32);
    const stream = xsalsa20Xor(key, nonce, padded);
    const ciphertext = stream.subarray(32);
    const mac = poly1305(stream.subarray(0, 32), ciphertext);
    const out = new Uint8Array(16 + ciphertext.length);
    out.set(mac);
    out.set(ciphertext, 16);
    return out;
}

/** crypto_box_beforenm: HSalsa20(X25519(sk, pk), 0^16). */
export function boxBeforeNm(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
    return hsalsa20(x25519(secretKey, publicKey), new Uint8Array(16));
}

/**
 * crypto_box_seal(message, recipientPublicKey). ephemeralSecret is for tests only; production draws 32 random
 * bytes. The ephemeral secret is zeroed before returning.
 */
export function sealedBox(
    message: Uint8Array,
    recipientPublicKey: Uint8Array,
    ephemeralSecret?: Uint8Array,
): Uint8Array {
    if (recipientPublicKey.length !== 32) {
        throw new Error("recipient public key must be 32 bytes");
    }
    const esk = ephemeralSecret ? Uint8Array.from(ephemeralSecret) : crypto.getRandomValues(new Uint8Array(32));
    const epk = x25519Public(esk);
    const nonceInput = new Uint8Array(64);
    nonceInput.set(epk);
    nonceInput.set(recipientPublicKey, 32);
    const nonce = blake2b(nonceInput, 24);
    const boxed = secretbox(message, nonce, boxBeforeNm(recipientPublicKey, esk));
    esk.fill(0);
    const out = new Uint8Array(32 + boxed.length);
    out.set(epk);
    out.set(boxed, 32);
    return out;
}
