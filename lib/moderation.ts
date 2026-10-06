/**
 * Server-side safety net for bot output (CometChat dashboard moderation is optional
 * on the free plan, so we never rely on it). Fails closed: if a line trips any rule,
 * the line is dropped, never "fixed".
 *
 * Patterns are matched on a normalised form (lowercase, leetspeak folded, separators
 * removed) so "s.e.x" or "n1gg" do not slip through.
 */

const SLUR_STEMS = [
  "nigg", "nigga", "faggot", "fagot", "retard", "tranny", "chink", "spic", "kike", "paki", "coon", "wetback",
  "gook", "raghead", "towelhead", "dyke", "shemale", "chamar", "bhangi", "chakka", "hijra", "katua", "mulla",
];

const SEXUAL_STEMS = [
  "sex", "porn", "nude", "nudes", "naked", "boob", "tits", "dick", "cock", "pussy", "cum", "horny", "blowjob",
  "handjob", "orgasm", "erotic", "fetish", "onlyfans", "xxx", "rape", "molest", "chut", "lund", "randi", "chod",
  "bhosd", "gaand",
];

/** Things that would expose a bot or break the fiction. */
const AI_TELLS = [
  /\bas an ai\b/i,
  /\b(ai|language) model\b/i,
  /\bi('?m| am) (an? )?(ai|bot|assistant|chatbot|llm)\b/i,
  /\bi('?m| am) not (a )?(real|human)\b/i,
  /\bsystem prompt\b/i,
  /\b(the|this|that|your) prompt\b/i,
  /\b(side[- ]?goal|objective|my mission)\b/i,
  /\b(openai|gemini|chatgpt|anthropic|claude|llama|groq)\b/i,
  /\bhow can i (help|assist)\b/i,
  /\bi('?d| would) be happy to\b/i,
  /\bpersona\b/i,
];

function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[0@]/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5|\$/g, "s")
    .replace(/7/g, "t");
}

/** Whole-word check for short stems (avoid "sex" matching "Essex" or "cum" in "document"). */
function containsStem(words: string[], squashed: string, stems: string[]): boolean {
  for (const stem of stems) {
    if (stem.length <= 4) {
      if (words.some((w) => w === stem || w === `${stem}s` || w === `${stem}y`)) return true;
    } else if (squashed.includes(stem)) {
      return true;
    }
  }
  return false;
}

export type ModerationVerdict = { ok: true } | { ok: false; reason: "slur" | "sexual" | "ai_tell" | "empty" | "too_long" };

export function moderateBotLine(text: string): ModerationVerdict {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.length > 220) return { ok: false, reason: "too_long" };
  const norm = normalise(trimmed);
  const words = norm.split(/[^a-z]+/).filter(Boolean);
  const squashed = norm.replace(/[^a-z]/g, "");
  if (containsStem(words, squashed, SLUR_STEMS)) return { ok: false, reason: "slur" };
  if (containsStem(words, squashed, SEXUAL_STEMS)) return { ok: false, reason: "sexual" };
  if (AI_TELLS.some((re) => re.test(trimmed))) return { ok: false, reason: "ai_tell" };
  return { ok: true };
}
