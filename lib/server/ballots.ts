import "server-only";
import { createECDH, createHmac } from "node:crypto";
import { aesKeyFromShared, fromB64url, seal, toB64url } from "@/lib/game/sealed";
import type { SealedBox } from "@/lib/game/types";
import { serverEnv } from "./env";

/**
 * The server's static ballot key, derived from SESSION_SECRET so every serverless instance agrees
 * without extra configuration. The public half is served by /api/key; the private half never leaves.
 */
let cached: { priv: Buffer; pub: string } | null = null;

function keypair() {
  if (cached) return cached;
  const ecdh = createECDH("prime256v1");
  // A 256-bit HMAC output is a valid P-256 scalar with overwhelming probability; re-derive if not.
  for (let i = 0; i < 4; i++) {
    try {
      ecdh.setPrivateKey(createHmac("sha256", serverEnv().SESSION_SECRET).update(`ballot-key:${i}`).digest());
      break;
    } catch {
      /* try the next derivation */
    }
  }
  cached = { priv: ecdh.getPrivateKey(), pub: toB64url(new Uint8Array(ecdh.getPublicKey())) };
  return cached;
}

export function ballotPublicKey(): string {
  return keypair().pub;
}

/** Bots' ballots are sealed exactly like humans', so envelopes are indistinguishable. */
export function sealForServer(payload: unknown): Promise<SealedBox> {
  return seal(payload, ballotPublicKey());
}

/** Open a sealed box. Returns null on any tampering or garbage. */
export async function openSealed(box: SealedBox): Promise<unknown> {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(keypair().priv);
    const shared = new Uint8Array(ecdh.computeSecret(Buffer.from(fromB64url(box.epk))));
    const key = await aesKeyFromShared(shared);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(box.iv) }, key, fromB64url(box.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}
