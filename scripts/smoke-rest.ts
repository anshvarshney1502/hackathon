/**
 * Live smoke test of every CometChat REST call the server relies on.
 *   npm run smoke:rest
 * Creates a throwaway room group, exercises it, and prints what CometChat returned.
 */
import { randomId } from "../lib/game/ids";
import { initialGameState } from "../lib/game/types";
import * as cc from "../lib/server/cometchat";
import { botUidForIndex } from "../lib/server/crypto";

async function main() {
  const human = `p-${randomId(12)}`;
  const bot = botUidForIndex(0);
  const guid = `nab-${randomId(6)}`;

  await cc.createUser(human, "Smoke Tester");
  const token = await cc.createAuthToken(human);
  console.log("auth token ok:", token.slice(0, 12) + "…");

  await cc.createGroup({ guid, name: "Smoke", metadata: { nab: initialGameState(Date.now()) }, participants: [human] });
  await cc.addParticipants(guid, [bot]);
  const members = await cc.listMembers(guid);
  console.log("members:", members.map((m) => `${m.name}:${m.status}:${m.scope}:${m.joinedAt}`));

  const group = await cc.getGroup(guid);
  console.log("metadata phase:", (group?.metadata as { nab?: { phase?: string } })?.nab?.phase);
  await cc.updateGroupMetadata(guid, { nab: { ...initialGameState(Date.now()), seq: 7 } });
  console.log("metadata seq after update:", ((await cc.getGroup(guid))?.metadata as { nab?: { seq?: number } })?.nab?.seq);

  for (let i = 1; i <= 3; i++) await cc.sendGroupText(guid, i % 2 ? bot : human, `line ${i}`);
  await cc.sendGroupCustom(guid, bot, "game.typing", { ms: 1500 });
  await cc.sendGroupCustom(guid, bot, "game.vote", { roundId: "r", ballots: { [human]: "BOT" } });

  const texts = await cc.listRecentGroupMessages(guid, { limit: 2, category: "message", type: "text" });
  console.log("last 2 texts (expect line 2, line 3):", texts.map((m) => `${m.data?.entities?.sender?.entity.name}: ${m.data?.text}`));
  const votes = await cc.listRecentGroupMessages(guid, { limit: 10, category: "custom", type: "game.vote" });
  console.log("votes:", votes.map((m) => JSON.stringify(m.data?.customData)));

  await cc.kickMember(guid, bot);
  console.log("members after kick:", (await cc.listMembers(guid)).length);
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
