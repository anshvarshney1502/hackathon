/**
 * Idempotent: creates the fixed pool of bot users in CometChat, or updates their
 * names if they already exist. Run as often as you like; it never duplicates.
 *
 *   npm run seed:bots
 *
 * UIDs are derived from SESSION_SECRET, so the same secret always maps to the same pool.
 * Changing SESSION_SECRET means a new pool, so run this again after rotating it.
 */
import { PERSONAS } from "../lib/bots/personas";
import * as cc from "../lib/server/cometchat";
import { botUidForIndex, NEUTRAL_NAME, sealName } from "../lib/server/crypto";
import { serverEnv } from "../lib/server/env";

async function main() {
  serverEnv(); // fail fast with a readable error if config is missing
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const [i, persona] of PERSONAS.entries()) {
    const uid = botUidForIndex(i);
    const existing = await cc.getUser(uid);
    // Bots carry the same neutral display name as humans; personas stay server-side.
    // Same metadata shape as humans (a sealed name), so its presence is not a tell.
    const metadata = { sn: sealName(persona.name) };
    if (!existing) {
      await cc.createUser(uid, NEUTRAL_NAME, metadata);
      created++;
      console.log(`+ ${persona.name.padEnd(10)} ${uid}`);
    } else if (existing.name !== NEUTRAL_NAME || typeof existing.metadata?.sn !== "string") {
      await cc.updateUserName(uid, NEUTRAL_NAME, metadata);
      updated++;
      console.log(`~ ${persona.name.padEnd(10)} ${uid}`);
    } else {
      unchanged++;
      console.log(`= ${persona.name.padEnd(10)} ${uid}`);
    }
  }
  console.log(`\nBot pool ready: ${created} created, ${updated} updated, ${unchanged} unchanged (${PERSONAS.length} total).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
