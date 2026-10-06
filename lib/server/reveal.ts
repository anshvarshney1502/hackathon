import "server-only";
import { evaluateObjective } from "@/lib/bots/objectives";
import { computeAwards, humanArchetype, revealOrder, scoreRound, withSocial, type BallotBox } from "@/lib/game/scoring";
import { socialSignals } from "@/lib/game/signals";
import { sanitizeTrust, tallyTrust } from "@/lib/game/trust";
import {
  CUSTOM_TYPES,
  DefenseEventSchema,
  type GameState,
  REVEAL_PREFACE_MS,
  type Reveal,
  type RevealDetail,
  TrustEventSchema,
  VoteEventSchema,
} from "@/lib/game/types";
import * as cc from "./cometchat";
import { openName, roundSalt } from "./crypto";
import { isBotUid, poolByUid, type RoomSnapshot } from "./room";
import { collectRound, collectSealed, objectivesFor, roundLines, rosterNames, seatedBots } from "./round";

/**
 * Everything the reveal shows is counted deterministically from CometChat history:
 * ballots, trust picks, event picks, defenses and chat lines. No LLM call.
 */
export async function buildReveal(
  room: RoomSnapshot,
  now: number,
): Promise<{ reveal: Reveal; detail: RevealDetail; allVoted: boolean }> {
  const state: GameState = room.state;
  const guid = room.guid;
  const [votes, trustRaw, defenses, lines] = await Promise.all([
    collectSealed(guid, state, CUSTOM_TYPES.vote, VoteEventSchema, { since: state.phaseStartedAt }),
    collectSealed(guid, state, CUSTOM_TYPES.trust, TrustEventSchema),
    collectRound(guid, state, CUSTOM_TYPES.defense, DefenseEventSchema, "first"),
    roundLines(guid, state),
  ]);

  const roster = rosterNames(state, room.members);
  const present = new Set(room.members.map((m) => m.uid));
  const players = roster.map((p) => ({
    uid: p.uid,
    name: p.name, // the round alias everyone knew them by
    isBot: isBotUid(p.uid),
  }));
  const box: BallotBox = Object.fromEntries(Object.entries(votes).map(([uid, v]) => [uid, v.ballots]));
  const allVoted = players.filter((p) => !p.isBot && present.has(p.uid)).every((p) => box[p.uid]);

  const trust = tallyTrust(sanitizeTrust(Object.fromEntries(Object.entries(trustRaw).map(([u, t]) => [u, { most: t.most, least: t.least }])), state.roster));
  const pointedAt: Record<string, number> = {};
  const defendedBy: Record<string, number> = {};
  for (const r of state.eventLog) {
    const into = r.type === "POINT" ? pointedAt : r.type === "DEFEND" ? defendedBy : null;
    if (into) for (const [uid, n] of Object.entries(r.counts)) into[uid] = (into[uid] ?? 0) + n;
  }
  const messages: Record<string, number> = {};
  for (const l of lines) messages[l.uid] = (messages[l.uid] ?? 0) + 1;

  const sig = socialSignals(lines, roster);
  const results = revealOrder(
    withSocial(scoreRound(players, box), {
      messages,
      trustMost: trust.most,
      trustLeast: trust.least,
      pointedAt,
      defendedBy,
      defended: new Set(Object.keys(defenses)),
    }),
    state.roundId ?? "",
  );
  const byUid = new Map(results.map((r) => [r.uid, r]));

  // Secret objectives: judged only now, and published only now.
  const bots = seatedBots(state, room.members);
  // Unseal real names now, and only now (CometChat display names are all "Player").
  const realNames = new Map<string, string>();
  await Promise.all(
    players
      .filter((p) => !p.isBot)
      .map(async (p) => {
        const u = await cc.getUser(p.uid).catch(() => null);
        const real = openName(u?.metadata?.sn);
        if (real) realNames.set(p.uid, real);
      }),
  );
  const pool = poolByUid();
  const objectives = objectivesFor(state, bots, roster);
  const humanVoters = new Set(players.filter((p) => !p.isBot).map((p) => p.uid));
  const maxBotVotes = Math.max(0, ...results.map((r) => r.votesBot));

  const detail: RevealDetail = {
    players: results.map((r) => {
      const persona = pool.get(r.uid)?.persona;
      const objective = objectives[r.uid];
      let status: "COMPLETED" | "FAILED" | null = null;
      if (objective && persona) {
        const target = objective.params.targetUid ? byUid.get(objective.params.targetUid) : undefined;
        status = evaluateObjective(objective, {
          botUid: r.uid,
          botName: r.name,
          lines,
          final: {
            fooled: r.fooled,
            trustMostFromOthers: Object.entries(trustRaw).filter(([voter, t]) => voter !== r.uid && t.most === r.uid).length,
            trustMostFromHumans: Object.entries(trustRaw).filter(([voter, t]) => humanVoters.has(voter) && t.most === r.uid).length,
            defendedBy: r.defendedBy,
            target: target && { votesBot: target.votesBot, votesHuman: target.votesHuman, trustLeast: target.trustLeast, pointedAt: target.pointedAt },
            isTopSuspect: r.votesBot > 0 && r.votesBot === maxBotVotes,
          },
        });
      }
      return {
        uid: r.uid,
        personaName: persona ? persona.name.slice(0, 30) : null,
        realName: r.isBot ? null : (realNames.get(r.uid) ?? "someone who left").slice(0, 40),
        trustedBy: Object.entries(trustRaw)
          .filter(([voter, t]) => voter !== r.uid && t.most === r.uid)
          .map(([voter]) => voter),
        humansSaidHuman: Object.entries(box).filter(([voter, b]) => humanVoters.has(voter) && b[r.uid] === "HUMAN").length,
        archetype: persona ? persona.tagline : humanArchetype(r, results, sig.disruptions),
        persona: persona ? { line: `${persona.age} · ${persona.occupation} · ${persona.city}`.slice(0, 80), traits: persona.traits.slice(0, 3) } : null,
        objective: objective && status ? { title: objective.title.slice(0, 90), status } : null,
        defense: defenses[r.uid]?.text ?? null,
      };
    }),
  };

  const reveal: Reveal = {
    roundId: state.roundId ?? "",
    botUids: players.filter((p) => p.isBot).map((p) => p.uid),
    salt: roundSalt(state.roundId ?? ""),
    // The social read-out (most / least trusted) plays first, then the spotlights.
    revealedAt: now + 1200 + REVEAL_PREFACE_MS,
    results,
    awards: computeAwards(results, sig.disruptions),
  };
  return { reveal, detail, allVoted };
}
