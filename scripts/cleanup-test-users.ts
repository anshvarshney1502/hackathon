/**
 * Frees CometChat user quota (the free plan allows 100 users in total) by removing users created
 * by the test scripts: "Smoke Tester" (smoke-rest) and "Sim A".."Sim F" (sim-table).
 * Real players and the bot pool are never touched.
 *
 *   npm run cleanup:test-users          # dry run: lists what would be deleted
 *   npm run cleanup:test-users -- --yes # permanently deletes them
 *   add --include-samples to also remove CometChat's 5 default sample users
 */
import * as cc from "../lib/server/cometchat";
import { openName } from "../lib/server/crypto";
import { isBotUid } from "../lib/server/room";

/**
 * Only names our own scripts generate: sim-table ("Sim A".."Sim F"), smoke-rest ("Smoke Tester") and the
 * abandoned Quick Match tests ("Quick 1".."Quick 9"). Real players, hosts and the bot pool never match.
 * CometChat's built-in sample users (cometchat-uid-1..5) are only included with --include-samples.
 */
const TEST_NAME = /^(Sim [A-Z]|Smoke Tester|Quick \d)$/;
const SAMPLE_UID = /^cometchat-uid-[1-5]$/;

async function main() {
  const doIt = process.argv.includes("--yes");
  const includeSamples = process.argv.includes("--include-samples");
  const doomed: { uid: string; label: string }[] = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const { users, totalPages } = await cc.listUsers(page);
    total += users.length;
    for (const u of users) {
      if (isBotUid(u.uid)) continue;
      const label = u.name === "Player" ? openName(u.metadata?.sn) ?? "" : u.name;
      if (TEST_NAME.test(label)) doomed.push({ uid: u.uid, label });
      else if (includeSamples && SAMPLE_UID.test(u.uid)) doomed.push({ uid: u.uid, label: `${label} (CometChat sample)` });
    }
    if (page >= totalPages) break;
  }
  console.log(`${total} users in the app. ${doomed.length} were created by test scripts:`);
  for (const d of doomed) console.log(`  ${d.uid}  ${d.label}`);
  if (!doIt) {
    console.log("\nDry run. Re-run with --yes to permanently delete them.");
    return;
  }
  for (const d of doomed) await cc.deleteUserPermanently(d.uid);
  console.log(`\nDeleted ${doomed.length} test users.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
