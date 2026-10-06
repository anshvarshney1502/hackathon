import "server-only";
import { assignDefenseTones, buildDefensePrompt, DefensePlanSchema, fallbackDefense } from "@/lib/bots/defense";
import { buildEventPrompt, eventParticipants, EventLinesSchema } from "@/lib/bots/eventLines";
import { humanize, tooSimilar, typingDurationMs } from "@/lib/bots/humanize";
import { BotPlanSchema, buildPrompt, chooseCandidates, type TickMode } from "@/lib/bots/planner";
import { ballotsFromView, socialView, trustFromView } from "@/lib/bots/temperament";
import { botBallots, type SpeakerStats } from "@/lib/bots/votes";
import { EVENT_SPECS } from "@/lib/game/events";
import { seededRandom } from "@/lib/game/rng";
import { socialSignals } from "@/lib/game/signals";
import { botTrustPick } from "@/lib/game/trust";
import { CUSTOM_TYPES, DEFENSE_MAX_CHARS, type GameState } from "@/lib/game/types";
import { generateStructured } from "@/lib/llm";
import { moderateBotLine } from "@/lib/moderation";
import * as cc from "./cometchat";
import { roundSeed } from "./crypto";
import { sealForServer } from "./ballots";
import { loadRoom, type PooledBot } from "./room";
import { botSituations, objectivesFor, roundLines, rosterNames, seatedBots, tableMemory } from "./round";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));



/** Bot chat budget: about 9 bot lines per minute of chat across the whole table. */
export function botLineBudget(chatSeconds: number): number {
  return Math.ceil((chatSeconds / 60) * 9);
}

/** Per-instance guard so the same trigger is never planned twice. */
const plannedKeys = new Map<string, number>();
function claim(key: string): boolean {
  const now = Date.now();
  for (const [k, at] of plannedKeys) if (now - at > 120_000) plannedKeys.delete(k);
  if (plannedKeys.has(key)) return false;
  plannedKeys.set(key, now);
  return true;
}

export type TickOutcome =
  | "sent"
  | "not_chat"
  | "no_trigger"
  | "duplicate"
  | "budget"
  | "llm_failed"
  | "nothing_to_say"
  | "event_running";

/** Chat events where free-form bot replies would break the rule ("one word only"). */
const EVENTS_THAT_PAUSE_REPLIES = new Set(["ONE_WORD", "RAPID_FIRE", "UNPOPULAR", "EVERYONE"]);
/** Events where one named player must answer questions put to them. */
const ON_THE_SPOT = new Set(["HOT_SEAT", "CROSS_EXAM", "CONTRADICTION"]);

function describeEvent(state: GameState, names: Map<string, string>): string | undefined {
  const e = state.event;
  if (!e) return undefined;
  const spec = EVENT_SPECS[e.type];
  return `${spec.title.toUpperCase()}: ${e.prompt}${e.targetUid ? ` (target: ${names.get(e.targetUid)})` : ""}`;
}

/**
 * One planning step. Called by the host (debounced) after messages, on silence, and
 * by the server itself at round start. Short-lived: plan → typing → wait → send, ≤ ~25 s.
 */
export async function runChatTick(guid: string, mode: TickMode): Promise<TickOutcome> {
  const room = await loadRoom(guid);
  if (!room) return "not_chat";
  const { state } = room;
  const now = Date.now();
  if (state.phase !== "CHAT" || !state.endsAt || !state.roundId || now > state.endsAt - 4000) return "not_chat";
  if (state.event && EVENTS_THAT_PAUSE_REPLIES.has(state.event.type)) return "event_running";

  const bots = seatedBots(state, room.members);
  if (bots.length === 0) return "no_trigger";

  const lines = await roundLines(guid, state);
  const botLines = lines.filter((l) => l.botKey).length;
  if (botLines >= botLineBudget(state.chatSeconds)) return "budget";

  const last = lines.at(-1);
  let key: string;
  if (mode === "opener") {
    if (lines.length > 0) return "no_trigger";
    key = `${state.roundId}:opener`;
  } else if (mode === "idle") {
    const quietFor = now - (last ? last.sentAt * 1000 : state.phaseStartedAt);
    if (quietFor < 5_500) return "no_trigger";
    key = `${state.roundId}:idle:${last?.id ?? 0}`;
  } else {
    if (!last) return "no_trigger";
    // Let bots banter, but never more than two bot lines in a row without a human.
    let trailing = 0;
    for (let i = lines.length - 1; i >= 0 && lines[i].botKey; i--) trailing++;
    // Bots talk to each other too, but a human always gets a gap within a few lines.
    if (trailing >= 3 || (trailing === 2 && Math.random() < 0.5)) return "no_trigger";
    key = `${state.roundId}:reply:${last.id}`;
  }
  if (!claim(key)) return "duplicate";

  const hotSeat = state.event && ON_THE_SPOT.has(state.event.type) ? state.event.targetUid : null;
  const { candidates, maxReplies } = chooseCandidates(bots, lines.slice(-20), mode, Math.random, hotSeat);
  if (candidates.length === 0 || maxReplies === 0) return "nothing_to_say";

  const roster = rosterNames(state, room.members);
  const situations = botSituations({
    bots: candidates.map((c) => bots.find((b) => b.uid === c.uid) as PooledBot),
    lines,
    roster,
    objectives: objectivesFor(state, bots, roster),
    hotSeatUid: hotSeat,
    eventLog: state.eventLog,
    seed: roundSeed(state.roundId),
  });
  const prompt = buildPrompt({
    topic: state.topic ?? "anything",
    secondsLeft: (state.endsAt - now) / 1000,
    lines: lines.slice(-20),
    candidates,
    maxReplies,
    mode,
    situations,
    event: describeEvent(state, new Map(roster.map((p) => [p.uid, p.name]))),
    memory: tableMemory(lines, roster, state.eventLog),
  });
  const plan = await generateStructured({ ...prompt, temperature: 1.05, maxOutputTokens: 400 }, BotPlanSchema);
  if (!plan.ok) {
    console.warn("[bots] plan skipped:", plan.reason);
    return "llm_failed";
  }

  const byKey = new Map(candidates.map((c) => [c.persona.key, c]));
  const used = new Set<string>();
  const replies = plan.data.replies
    .filter((r) => byKey.has(r.bot) && !used.has(r.bot) && used.add(r.bot))
    .slice(0, maxReplies);
  if (replies.length === 0) return "nothing_to_say";

  // Independent scheduling: each bot has its own reaction time (temperament speed, message length,
  // a dash of chance). No fixed queue; a fast bot can beat a slow one. Only a minimum gap keeps two
  // messages from landing in the same instant.
  const timed = replies
    .map((r) => {
      const bot = byKey.get(r.bot) as PooledBot;
      const speed = bot.temperament?.speed ?? 1;
      const short = r.message.length < 28;
      const think = short
        ? 300 + Math.random() * 1400
        : Math.min(3500, Math.max(800, r.thinkTimeMs ?? 1600)) * (0.6 + Math.random() * 0.7);
      return { r, bot, start: think / speed };
    })
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < timed.length; i++) timed[i].start = Math.max(timed[i].start, timed[i - 1].start + 700 + Math.random() * 900);
  const jobs = timed.map(({ r, bot, start }) => deliver(guid, state, bot, r.message, start, { previous: lines.filter((l) => l.uid === bot.uid).map((l) => l.text) }));
  const results = await Promise.all(jobs);
  return results.some(Boolean) ? "sent" : "nothing_to_say";
}

async function deliver(
  guid: string,
  state: GameState,
  bot: PooledBot,
  raw: string,
  startInMs: number,
  opts: { oneWord?: boolean; maxWords?: number; eventId?: string; previous?: string[] } = {},
): Promise<boolean> {
  const line = humanize(raw, bot.persona, Math.random, opts);
  if (!line) return false;
  // Nobody addresses themselves by name.
  const self = bot.name.toLowerCase().split(/[\s_.]/)[0];
  if (self.length > 1 && new RegExp(`(^|[^a-z])${self}([^a-z]|$)`, "i").test(line.text)) {
    console.info("[bots] dropped a self-address");
    return false;
  }
  if (opts.previous?.some((p) => tooSimilar(p, line.text))) {
    console.info("[bots] dropped a repeat");
    return false;
  }
  const verdict = moderateBotLine(line.text);
  if (!verdict.ok) {
    console.warn("[bots] line dropped by moderation:", verdict.reason);
    return false;
  }
  const typing = opts.oneWord ? 900 + Math.random() * 900 : typingDurationMs(line.text, bot.persona);
  await sleep(startInMs);
  if (!(await stillChatting(guid, state.roundId, opts.eventId))) return false;
  try {
    await cc.sendGroupCustom(guid, bot.uid, CUSTOM_TYPES.typing, { ms: Math.round(typing + 600) });
    await sleep(typing);
    await cc.sendGroupText(guid, bot.uid, line.text);
    if (line.correction) {
      await sleep(900 + Math.random() * 1200);
      await cc.sendGroupText(guid, bot.uid, line.correction);
    }
    return true;
  } catch (e) {
    console.warn("[bots] send failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

async function currentState(guid: string): Promise<{ phase?: string; roundId?: string; endsAt?: number; event?: { id?: string } | null } | undefined> {
  const room = await cc.getGroup(guid);
  return (room?.metadata as { nab?: { phase?: string; roundId?: string; endsAt?: number; event?: { id?: string } | null } } | undefined)?.nab;
}

/** Cheap re-check so a late reply never lands in the next phase (or after its event). */
async function stillChatting(guid: string, roundId: string | null, eventId?: string): Promise<boolean> {
  const nab = await currentState(guid);
  if (nab?.phase !== "CHAT" || nab.roundId !== roundId || (nab.endsAt ?? 0) <= Date.now() + 1500) return false;
  return eventId ? nab.event?.id === eventId : true;
}

/* ------------------------------------------------------------------ trust */

/** Bots choose who they trust most / least from the conversation, at human-ish moments. */
export async function castBotTrust(guid: string, state: GameState): Promise<void> {
  const room = await loadRoom(guid);
  if (!room || !state.roundId) return;
  const bots = seatedBots(state, room.members);
  const roster = rosterNames(state, room.members);
  const sig = socialSignals(await roundLines(guid, state), roster);
  const seed = roundSeed(state.roundId);
  const window = Math.max(4_000, (state.endsAt ?? Date.now() + 20_000) - Date.now() - 4_000);
  await Promise.all(
    bots.map(async (bot) => {
      const view = bot.temperament ? socialView(bot.uid, state.roster, sig, bot.temperament, seed) : null;
      const pick = (view && trustFromView(view)) ?? botTrustPick(bot.uid, state.roster, sig, bot.persona.paranoia, seededRandom(`trust:${seed}:${bot.uid}`));
      if (!pick) return;
      await sleep(2_500 + Math.random() * (window - 2_500));
      await cc
        .sendGroupCustom(guid, bot.uid, CUSTOM_TYPES.trust, {
          roundId: state.roundId,
          sealed: await sealForServer({ roundId: state.roundId, most: pick.most, least: pick.least }),
        })
        .catch((e: unknown) => console.warn("[bots] trust failed:", e instanceof Error ? e.message : e));
    }),
  );
}

/* ------------------------------------------------------------------ final defense */

/**
 * Every bot submits exactly one final defense, written for this phase (one LLM call for all
 * bots). If the model fails or a line is moderated away, an in-character fallback is used,
 * so no bot is ever silent in a way that gives it away.
 */
export async function castBotDefenses(guid: string, state: GameState): Promise<void> {
  const room = await loadRoom(guid);
  if (!room || !state.roundId) return;
  const bots = seatedBots(state, room.members);
  if (bots.length === 0) return;
  const roster = rosterNames(state, room.members);
  const lines = await roundLines(guid, state);
  const seed = roundSeed(state.roundId);
  // Fairness: a bot knows only what a player could. Public event results count; private trust picks don't.
  const situations = botSituations({ bots, lines, roster, objectives: objectivesFor(state, bots, roster), eventLog: state.eventLog, seed });
  const tones = assignDefenseTones(seed, bots.map((b) => b.persona.key));
  const plan = await generateStructured(
    {
      ...buildDefensePrompt({ topic: state.topic ?? "anything", lines: lines.slice(-24), bots, tones, situations }),
      temperature: 1.0,
      maxOutputTokens: 500,
    },
    DefensePlanSchema,
  );
  if (!plan.ok) console.warn("[bots] defense plan fell back:", plan.reason);
  const byKey = new Map(plan.ok ? plan.data.defenses.map((d) => [d.bot, d.message]) : []);

  const window = Math.max(4_000, (state.endsAt ?? Date.now() + 15_000) - Date.now() - 3_000);
  await Promise.all(
    bots.map(async (bot) => {
      const random = seededRandom(`defense:${seed}:${bot.uid}`);
      let text = humanize(byKey.get(bot.persona.key) ?? "", bot.persona, Math.random, { maxWords: 20 })?.text ?? "";
      if (!text || !moderateBotLine(text).ok) text = fallbackDefense(bot.persona, tones[bot.persona.key], random);
      text = text.slice(0, DEFENSE_MAX_CHARS);
      const typing = typingDurationMs(text, bot.persona);
      await sleep(Math.max(500, 1_500 + Math.random() * (window - typing - 1_500)));
      try {
        await cc.sendGroupCustom(guid, bot.uid, CUSTOM_TYPES.typing, { ms: Math.round(typing + 600) });
        await sleep(Math.min(typing, 4_000));
        await cc.sendGroupCustom(guid, bot.uid, CUSTOM_TYPES.defense, { roundId: state.roundId, text });
      } catch (e) {
        console.warn("[bots] defense failed:", e instanceof Error ? e.message : e);
      }
    }),
  );
}

/* ------------------------------------------------------------------ interrogation events */

const HOT_SEAT_FALLBACKS = [
  "{name} where did you grow up?",
  "ok {name}, what did you eat today?",
  "{name} what's on your phone lock screen rn?",
  "{name} last song you played?",
];

/** Bot participation in an interrogation event: chat lines (one LLM call) or deterministic picks. */
export async function runEventBots(guid: string, state: GameState): Promise<void> {
  const event = state.event;
  const room = await loadRoom(guid);
  if (!room || !event || !state.roundId) return;
  const bots = seatedBots(state, room.members);
  if (bots.length === 0) return;
  const roster = rosterNames(state, room.members);
  const seed = roundSeed(state.roundId);
  const spec = EVENT_SPECS[event.type];
  const lines = await roundLines(guid, state);
  const window = Math.max(3_000, event.endsAt - Date.now() - 2_500);

  if (spec.mode === "pick") {
    const sig = socialSignals(lines, roster);
    await Promise.all(
      bots.map(async (bot) => {
        const r = seededRandom(`pick:${seed}:${event.id}:${bot.uid}`);
        const view = bot.temperament ? socialView(bot.uid, state.roster, sig, bot.temperament, seed) : null;
        const pick = (view && trustFromView(view)) ?? botTrustPick(bot.uid, state.roster, sig, bot.persona.paranoia, r);
        if (!pick) return;
        // Memory check: remember correctly a bit more often than not, like a person skimming the chat.
        const word = event.prompt.match(/mentioned (\S+) earlier/i)?.[1]?.toLowerCase();
        const owner = word ? lines.find((l) => l.text.toLowerCase().includes(word))?.uid : undefined;
        const others = state.roster.filter((u) => u !== bot.uid);
        const memoryPick =
          event.type === "MEMORY"
            ? owner && owner !== bot.uid && r() < 0.6
              ? owner
              : others[Math.floor(r() * others.length)]
            : null;
        await sleep(2_000 + Math.random() * (window - 2_000));
        await cc
          .sendGroupCustom(guid, bot.uid, CUSTOM_TYPES.pick, {
            roundId: state.roundId,
            eventId: event.id,
            sealed: await sealForServer({ roundId: state.roundId, eventId: event.id, pick: memoryPick ?? (event.type === "POINT" ? pick.least : pick.most) }),
          })
          .catch((e: unknown) => console.warn("[bots] pick failed:", e instanceof Error ? e.message : e));
      }),
    );
    return;
  }

  const participants = eventParticipants(event, bots, seededRandom(`who:${seed}:${event.id}`));
  if (participants.length === 0) return;
  const target = roster.find((p) => p.uid === event.targetUid);
  const plan = await generateStructured(
    {
      ...buildEventPrompt({ event, targetName: target?.name ?? null, topic: state.topic ?? "anything", lines, bots: participants }),
      temperature: 1.05,
      maxOutputTokens: 300,
    },
    EventLinesSchema,
  );
  const lines_ = plan.ok
    ? plan.data.lines.filter((l) => event.type !== "CROSS_EXAM" || l.message.includes("?"))
    : [];
  if (!plan.ok) console.warn("[bots] event lines fell back:", plan.reason);
  // A cross-examination must never be dead air: if the model gave no usable question, ask a simple one.
  if (event.type === "CROSS_EXAM" && lines_.length === 0 && target && participants[0]) {
    const q = HOT_SEAT_FALLBACKS[Math.floor(Math.random() * HOT_SEAT_FALLBACKS.length)].replace("{name}", target.name);
    lines_.push({ bot: participants[0].persona.key, message: q });
  }
  if (lines_.length === 0) return;
  const byKey = new Map(participants.map((p) => [p.persona.key, p]));
  const quick = event.type === "RAPID_FIRE" || event.type === "ONE_WORD";
  let offset = quick ? 800 : 2_500;
  await Promise.all(
    lines_
      .filter((l) => byKey.has(l.bot))
      .map((l) => {
        const start = Math.min(window, offset + Math.random() * (quick ? 1_500 : 3_000));
        offset = start + (quick ? 600 : 2_000);
        return deliver(guid, state, byKey.get(l.bot) as PooledBot, l.message, start, {
          oneWord: event.type === "ONE_WORD",
          maxWords: event.type === "RAPID_FIRE" ? 6 : 14,
          eventId: event.id,
        });
      }),
  );
}

/* ------------------------------------------------------------------ votes */

/** Bots cast ballots at human-ish moments, swayed a little by the room's mood. */
export async function castBotVotes(guid: string, state: GameState): Promise<void> {
  const room = await loadRoom(guid);
  if (!room || !state.roundId) return;
  const bots = seatedBots(state, room.members);
  const lines = await roundLines(guid, state);
  const sig = socialSignals(lines, rosterNames(state, room.members));
  const seed = roundSeed(state.roundId);
  const stats: Record<string, SpeakerStats> = {};
  for (const l of lines) {
    const s = (stats[l.uid] ??= { messages: 0, avgLength: 0 });
    s.avgLength = (s.avgLength * s.messages + l.text.length) / (s.messages + 1);
    s.messages++;
  }
  // Room mood from public information only: event results everyone saw (never private trust picks).
  const heat: Record<string, number> = {};
  for (const r of state.eventLog) {
    for (const [uid, n] of Object.entries(r.counts)) heat[uid] = (heat[uid] ?? 0) + (r.type === "POINT" ? n : -n);
  }
  const window = Math.max(5_000, (state.endsAt ?? Date.now() + 25_000) - Date.now() - 4_000);
  await Promise.all(
    bots.map(async (bot) => {
      await sleep(2_500 + Math.random() * (window - 2_500));
      // Each bot votes from its own private read of the table (temperament + hunches), not a shared one.
      const view = bot.temperament ? socialView(bot.uid, state.roster, sig, bot.temperament, seed) : null;
      const ballots = view ? ballotsFromView(view, Math.random) : botBallots({ uid: bot.uid, persona: bot.persona }, state.roster, stats, Math.random, heat);
      try {
        await cc.sendGroupCustom(guid, bot.uid, CUSTOM_TYPES.vote, {
          roundId: state.roundId,
          sealed: await sealForServer({ roundId: state.roundId, ballots }),
        });
      } catch (e) {
        console.warn("[bots] vote failed:", e instanceof Error ? e.message : e);
      }
    }),
  );
}
