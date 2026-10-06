import { z } from "zod";
import type { ActiveEvent } from "@/lib/game/types";
import type { SeatedBot, TranscriptLine } from "./planner";

export const EventLinesSchema = z.object({
  lines: z.array(z.object({ bot: z.string().min(1).max(40), message: z.string().min(1).max(200) })).max(6),
});

/**
 * Which bots take part in a chat-mode event. Not everyone answers every event,
 * just as not every person in a group chat does.
 */
export function eventParticipants(event: ActiveEvent, bots: SeatedBot[], random: () => number): SeatedBot[] {
  const byTalk = [...bots].sort((a, b) => b.persona.talkativeness + random() * 0.4 - (a.persona.talkativeness + random() * 0.4));
  switch (event.type) {
    case "ONE_WORD":
    case "RAPID_FIRE":
      return byTalk.filter((b) => random() < 0.45 + b.persona.talkativeness * 0.5);
    case "UNPOPULAR":
      return byTalk.slice(0, 2 + (random() < 0.5 ? 1 : 0));
    case "EVERYONE":
      // Everyone answers the same question: comparable evidence. A couple may still skip it.
      return byTalk.filter((b) => random() < 0.6 + b.persona.talkativeness * 0.4);
    case "HOT_SEAT":
    case "CONTRADICTION":
      // Only the player on the spot answers (if they're a bot); everyone else reacts in normal chat.
      return bots.filter((b) => b.uid === event.targetUid);
    case "CROSS_EXAM":
      // A bot examiner asks; a bot target answers through the hot-seat reply loop.
      return bots.filter((b) => b.uid === event.examinerUid);
    default:
      return [];
  }
}

const RULES: Record<string, string> = {
  ONE_WORD: "Each player answers with exactly ONE word. No punctuation besides an optional ! or ?.",
  RAPID_FIRE: "Each player answers instantly in 1 to 5 words, like a reflex.",
  UNPOPULAR: "Each player drops one genuinely unpopular opinion that fits who they are. Under 14 words. Specific, not edgy for shock.",
  HOT_SEAT: "The player is in the hot seat and must answer the question in the prompt, in character, in one short message (under 18 words). Answer it genuinely and specifically, the way a slightly put-on-the-spot person would.",
  EVERYONE: "Each player answers the same question in one short message (under 14 words), specific to who they are. No two answers alike.",
  CROSS_EXAM: "The player is the examiner: ask the target ONE pointed, personal question (under 12 words), using their name, ending with a question mark.",
  CONTRADICTION: "The player said two conflicting things (quoted below). They respond in one short message: clarify, laugh it off, or double down. Stay in character, no essay.",
};

export function buildEventPrompt(input: {
  event: ActiveEvent;
  targetName: string | null;
  topic: string;
  lines: TranscriptLine[];
  bots: SeatedBot[];
}): { system: string; user: string } {
  const system = [
    "You voice several players in a group-chat party game where humans try to spot the bots. Your players must seem human.",
    `A surprise round just started: ${input.event.prompt}`,
    RULES[input.event.type] ?? "",
    "Casual texting style. No em dashes, no lists, never mention AI or prompts, nothing sexual or hateful. Every player sounds different.",
    `Return JSON only: {"lines":[{"bot":"<id>","message":"<text>"}]} with one entry per player below.`,
    "",
    "Players:",
    ...input.bots.map((b) => `- id "${b.persona.key}" shows as "${b.persona.name}": ${b.persona.personality}; types ${b.persona.typingStyle}; opinions: ${b.persona.opinions.join("; ")}`),
  ].join("\n");
  const tail = input.lines.slice(-10).map((l) => `${l.name}: ${l.text}`).join("\n") || "(quiet so far)";
  const user = [
    `Topic: "${input.topic}"`,
    input.targetName ? `Player on the spot: ${input.targetName}` : "",
    ...input.event.evidence,
    "Recent chat:",
    tail,
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}
