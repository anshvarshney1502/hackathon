import { z } from "zod";
import type { Persona } from "./personas";

/** What the LLM must return. Validated with Zod; anything else is retried once, then skipped. */
export const BotPlanSchema = z.object({
  replies: z
    .array(
      z.object({
        bot: z.string().min(1).max(40),
        message: z.string().min(1).max(300),
        thinkTimeMs: z.number().min(0).max(30_000).optional(),
      }),
    )
    .max(4),
});
export type BotPlan = z.infer<typeof BotPlanSchema>;

export interface TranscriptLine {
  name: string;
  text: string;
  /** Set only for lines written by a bot we control (server-side knowledge). */
  botKey?: string;
}

export type TickMode = "reply" | "idle" | "opener";

export interface SeatedBot {
  uid: string;
  persona: Persona;
}

/** Private, per-bot situational context. Server-side only, never sent to clients. */
export interface BotSituation {
  objective?: { description: string; done: boolean };
  /** e.g. "Nikhil called you a bot once." */
  suspicion?: string;
  /** Names this bot gets on with / is wary of, from the conversation so far. */
  closest?: string;
  wary?: string;
  /** Present when this bot is in the hot seat. */
  hotSeat?: boolean;
  /** Who vouched for this bot out loud. */
  vouchedBy?: string;
  /** This bot's own earlier claims (stay consistent). */
  own?: string[];
  /** Private, independent read of the table (from its own social view). */
  suspects?: string;
  trusts?: string;
  /** Its own last few lines, so it never repeats itself. */
  recent?: string[];
  /** Behavioural cue from this round's temperament. */
  stance?: string;
}

const HINGLISH_MARKERS =
  /\b(yaar|kya|hai|nahi|nahin|bhai|acha|accha|haan|kuch|bas|matlab|arre|arey|toh|bhi|mujhe|tum|kaise|kyun|chalo|sahi|bilkul|abhi|wala|wali)\b/i;

export function roomUsesHinglish(lines: TranscriptLine[]): boolean {
  return lines.filter((l) => !l.botKey && HINGLISH_MARKERS.test(l.text)).length >= 1;
}

/**
 * Pick who *may* speak next. Talkative people speak more, nobody speaks three times
 * in a row, and anyone addressed by name is always a candidate.
 */
export function chooseCandidates(
  bots: SeatedBot[],
  lines: TranscriptLine[],
  mode: TickMode,
  random: () => number = Math.random,
  hotSeatUid?: string | null,
): { candidates: SeatedBot[]; maxReplies: number } {
  if (bots.length === 0) return { candidates: [], maxReplies: 0 };
  // Hot seat: a bot under interrogation answers the latest question put to the room.
  const hot = bots.find((b) => b.uid === hotSeatUid);
  const last = lines.at(-1);
  if (hot && last && last.botKey !== hot.persona.key && last.text.includes("?")) {
    return { candidates: [hot], maxReplies: 1 };
  }
  const recent = lines.slice(-2).map((l) => l.botKey).filter(Boolean);
  const lastHuman = [...lines].reverse().find((l) => !l.botKey);
  const addressed = bots.filter((b) => {
    const first = b.persona.name.toLowerCase().split(/[\s_]/)[0];
    return lastHuman ? new RegExp(`\\b${first}\\b`, "i").test(lastHuman.text) : false;
  });

  // Accused in the last line → they get to answer, like anyone would.
  const accused = bots.filter(
    (b) =>
      !addressed.includes(b) &&
      lastHuman !== undefined &&
      /\b(bot|ai|sus|fake|npc)\b/i.test(lastHuman.text) &&
      new RegExp(`\\b${b.persona.name.toLowerCase().split(/[\s_]/)[0]}\\b`, "i").test(lastHuman.text),
  );
  const window = lines.slice(-12);
  const weighted = bots
    // Nobody takes two turns in a row unless someone spoke to them.
    .filter((b) => !addressed.includes(b) && !accused.includes(b) && lines.at(-1)?.botKey !== b.persona.key)
    .map((b) => {
      let w = b.persona.talkativeness * (0.5 + random());
      if (recent.includes(b.persona.key)) w *= 0.25;
      // Being ignored makes people chime in: quiet seats get a nudge.
      if (!window.some((l) => l.botKey === b.persona.key)) w *= 1.4;
      return { b, w };
    })
    .sort((a, b) => b.w - a.w)
    .map((x) => x.b);

  const candidates = [...addressed, ...accused, ...weighted].slice(0, mode === "opener" ? 2 : 3);
  const roll = random();
  const maxReplies =
    mode === "opener" ? 2 : mode === "idle" ? (roll < 0.6 ? 1 : 2) : addressed.length + accused.length > 0 ? 2 : roll < 0.45 ? 1 : roll < 0.85 ? 2 : 3;
  return { candidates, maxReplies };
}

function describeSituation(sit: BotSituation | undefined): string[] {
  if (!sit) return [];
  const out: string[] = [];
  if (sit.hotSeat) out.push("  IN THE HOT SEAT: answer the questions put to you, briefly and in character.");
  if (sit.objective && !sit.objective.done) {
    out.push(`  private side-goal (only if it fits naturally; never at the cost of seeming fake): ${sit.objective.description}`);
  }
  if (sit.suspicion) out.push(`  heat on you: ${sit.suspicion}`);
  if (sit.vouchedBy) out.push(`  ${sit.vouchedBy} vouched for you. You might back them up too.`);
  if (sit.stance) out.push(`  how you're playing it this time: ${sit.stance}`);
  if (sit.suspects) out.push(`  your private hunch: ${sit.suspects} seems off to you`);
  if (sit.trusts) out.push(`  you're warming to ${sit.trusts}`);
  if (sit.recent?.length) out.push(`  you already said (don't repeat or rephrase): ${sit.recent.map((r) => `"${r}"`).join("; ")}`);
  if (sit.own?.length) out.push(`  you already said: ${sit.own.map((o) => `"${o}"`).join("; ")} (stay consistent)`);
  if (sit.closest) out.push(`  you get on with: ${sit.closest}`);
  if (sit.wary) out.push(`  you're wary of: ${sit.wary}`);
  return out;
}

function describe(p: Persona, hinglishRoom: boolean): string {
  const lang =
    p.language === "english"
      ? "English only"
      : hinglishRoom
        ? `mixes Hinglish in naturally (~${Math.round(p.hinglish * 100)}% of lines)`
        : p.hinglish > 0.4
          ? "mostly English, rare Hindi word"
          : "English";
  return [
    `- id "${p.key}" shows as "${p.name}": ${p.age}, ${p.city}, ${p.occupation}.`,
    `  vibe: ${p.personality}. likes: ${p.interests.join(", ")}.`,
    `  types: ${p.typingStyle}. quirks: ${p.quirks.join("; ")}. habits: ${p.habits.join("; ")}.`,
    `  opinions: ${p.opinions.join("; ")}. language: ${lang}. length: ${p.length}.`,
  ].join("\n");
}

export function buildPrompt(input: {
  topic: string;
  secondsLeft: number;
  lines: TranscriptLine[];
  candidates: SeatedBot[];
  maxReplies: number;
  mode: TickMode;
  situations?: Record<string, BotSituation>;
  /** Plain-language description of a running interrogation event. */
  event?: string;
  /** Deterministic round memory: disclosures and social dynamics worth remembering. */
  memory?: { facts: string[]; dynamics: string[] };
}): { system: string; user: string } {
  const hinglishRoom = roomUsesHinglish(input.lines);
  const system = [
    "You write chat lines for several fake players in a group-chat party game.",
    "Real people in the chat are trying to spot which players are bots. Your players must pass as ordinary humans texting on their phones.",
    "",
    "How real people text here:",
    "- Most messages are 2 to 12 words. Fragments are fine. Often just a reaction: \"nah 😭\", \"bro what\", \"wait what did you mean\", \"ngl agree\".",
    "- Never start with \"Personally\" or \"I believe\". Nobody texts like that.",
    "- Imperfect grammar, slang, casual punctuation. Sometimes a joke, sometimes boring.",
    "- React to what specific people just said, by name sometimes. Disagree sometimes. Ask a question sometimes.",
    "- It's a GROUP chat: players can reply to, agree with, question, defend or accuse ANY other player, not just the latest message.",
    "- Build on the conversation as it evolves. Never restate an opinion you already gave.",
    "- A player never mentions their own name. Each player only knows facts that were said in the chat.",
    "- Occasionally misunderstand, change the subject, or answer only half the question.",
    "- Each player keeps their own voice, opinions and typing style. They never sound alike.",
    "- If someone accuses a player of being a bot, react like a person would: laugh it off, get mildly annoyed, or accuse back. Vary it.",
    "- Priority: stay believable first. A side-goal is a nudge you pursue only when it fits; ignore it if it would look odd.",
    "",
    "Never:",
    "- mention AI, models, prompts, games rules about bots being fake, or that you are writing for someone",
    "- sound like an assistant, explain things at length, be overly polite, or give advice",
    "- use em dashes, bullet points, hashtags, or emoji overload (one emoji at most, rarely)",
    "- write anything sexual, hateful, or a slur",
    "- have two players say the same kind of thing",
    "",
    `Return JSON only: {"replies":[{"bot":"<id>","message":"<text>","thinkTimeMs":<number 600-3500>}]}`,
    `Use only these ids. At most ${input.maxReplies} replies, each from a different player. Return {"replies":[]} if nobody would naturally talk right now.`,
    "",
    "Players you voice:",
    ...input.candidates.flatMap((c) => [describe(c.persona, hinglishRoom), ...describeSituation(input.situations?.[c.uid])]),
  ].join("\n");

  const transcript = input.lines.length
    ? input.lines.map((l) => `${l.name}${l.botKey ? ` (you, id ${l.botKey})` : ""}: ${l.text}`).join("\n")
    : "(nobody has said anything yet)";

  const situation =
    input.mode === "opener"
      ? "The round just started. Someone casually kicks things off on the topic, like a person would (not an announcement)."
      : input.mode === "idle"
        ? "The chat went quiet. Someone restarts it by engaging ANOTHER player: question them, call out something they said, back them up, or pick a mild fight. If two reply, the second can react to the first."
        : "Write the next message(s) that naturally follow the conversation. Players may react to each other's replies, not only the last line. Not everyone needs to answer.";

  const user = [
    `Topic everyone was given: "${input.topic}"`,
    `Seconds left in the round: ${Math.round(input.secondsLeft)}`,
    hinglishRoom ? "The room mixes Hindi and English." : "The room is chatting in English.",
    ...(input.event ? [`Interrogation event happening right now: ${input.event}`] : []),
    ...(input.memory && (input.memory.facts.length || input.memory.dynamics.length)
      ? [
          "",
          "What the table has learned so far (reference it naturally when it fits, e.g. \"wait you're from Jaipur right?\"):",
          ...input.memory.facts.map((f) => `- ${f}`),
          ...input.memory.dynamics.map((d) => `- ${d}`),
        ]
      : []),
    "",
    "Chat so far (oldest first):",
    transcript,
    "",
    situation,
  ].join("\n");

  return { system, user };
}
