import type { SealedBox } from "./types";

/**
 * Sealed ballots: ECDH P-256 (ephemeral sender key × server static key) → SHA-256 → AES-256-GCM.
 * Uses WebCrypto only, so the exact same code seals in the browser, on the server (bot ballots)
 * and in tests. Opening needs the server's private key and lives in lib/server/ballots.ts.
 */

function toB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export { toB64url };

/** Derive the AES key from the raw 32-byte ECDH shared x-coordinate. Same on both sides. */
export async function aesKeyFromShared(shared: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", shared);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt a JSON payload to the server's public key (raw uncompressed P-256 point, base64url). */
export async function seal(payload: unknown, serverPublicKey: string): Promise<SealedBox> {
  const serverKey = await crypto.subtle.importKey("raw", fromB64url(serverPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, eph.privateKey, 256));
  const key = await aesKeyFromShared(shared);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  return { epk: toB64url(epk), iv: toB64url(iv), ct: toB64url(ct) };
}
