import { z } from "zod";
import { seededRandom, shuffled } from "@/lib/game/rng";
import { DEFENSE_MAX_CHARS } from "@/lib/game/types";
import type { BotSituation, SeatedBot, TranscriptLine } from "./planner";
import type { Persona } from "./personas";

/** Each bot pleads in a different register, so the defenses never sound alike. */
export const DEFENSE_TONES = ["confident", "joking", "defensive", "slightly suspicious", "extremely casual"] as const;
export type DefenseTone = (typeof DEFENSE_TONES)[number];

export function assignDefenseTones(seed: string, botKeys: string[]): Record<string, DefenseTone> {
  const tones = shuffled(DEFENSE_TONES, seededRandom(`tones:${seed}`));
  return Object.fromEntries(botKeys.map((k, i) => [k, tones[i % tones.length]]));
}

export const DefensePlanSchema = z.object({
  defenses: z.array(z.object({ bot: z.string().min(1).max(40), message: z.string().min(1).max(300) })).max(6),
});

const FALLBACK: Record<DefenseTone, string[]> = {
  confident: ["i've been talking about my actual life this whole time. vote how you want", "read the chat back. i'm the most normal person here"],
  joking: ["if i was a bot i'd at least have better opinions than this", "a bot would've typed faster than me, trust"],
  defensive: ["why is everyone looking at me, i literally answered everything", "ok i was quiet, that's not a crime"],
  "slightly suspicious": ["i mean... would a bot say it's not a bot", "define human tbh"],
  "extremely casual": ["human. tired. hungry. that's the defense", "yeah im human lol, anyway"],
};

/** Used when the LLM is unavailable: every bot still gets exactly one defense. */
export function fallbackDefense(persona: Persona, tone: DefenseTone, random: () => number): string {
  const options = FALLBACK[tone];
  const line = options[Math.floor(random() * options.length)];
  return persona.lowercase ? line : line.charAt(0).toUpperCase() + line.slice(1);
}

export function buildDefensePrompt(input: {
  topic: string;
  lines: TranscriptLine[];
  bots: SeatedBot[];
  tones: Record<string, DefenseTone>;
  situations: Record<string, BotSituation>;
}): { system: string; user: string } {
  const system = [
    "You write the FINAL DEFENSE for several players in a group-chat party game.",
    "Everyone is about to vote on who is human. Each of your players gets exactly ONE last message to convince the room they're human.",
    "Write like a real person texting under pressure. 3 to 18 words. No em dashes, no hashtags, no lists.",
    "Never mention AI, models, prompts or that you are writing for someone. Nothing sexual or hateful.",
    "Each player uses their own voice and the tone given. Reference something from the chat when it helps.",
    `Max ${DEFENSE_MAX_CHARS} characters each.`,
    `Return JSON only: {"defenses":[{"bot":"<id>","message":"<text>"}]} with exactly one entry per player below.`,
    "",
    "Players:",
    ...input.bots.map((b) => {
      const sit = input.situations[b.uid];
      return [
        `- id "${b.persona.key}" shows as "${b.persona.name}" (${b.persona.age}, ${b.persona.city}, ${b.persona.occupation}).`,
        `  types: ${b.persona.typingStyle}. vibe: ${b.persona.personality}. tone for this defense: ${input.tones[b.persona.key]}.`,
        sit?.suspicion ? `  heat on them: ${sit.suspicion}` : "  nobody has singled them out.",
        sit?.objective && !sit.objective.done ? `  private side-goal, only if natural: ${sit.objective.description}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }),
  ].join("\n");
  const transcript = input.lines.length ? input.lines.map((l) => `${l.name}: ${l.text}`).join("\n") : "(the chat was quiet)";
  return { system, user: `Topic: "${input.topic}"\n\nThe chat:\n${transcript}\n\nWrite each player's one final defense.` };
}
