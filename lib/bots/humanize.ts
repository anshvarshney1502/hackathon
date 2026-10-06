import type { Persona } from "./personas";

/**
 * Turns a model line into something a specific person would actually type.
 * Deterministic given the injected RNG, so it is unit-testable.
 */
export interface Humanized {
  text: string;
  /** Optional "*fix" follow-up after a deliberate typo. */
  correction: string | null;
}

const MAX_WORDS: Record<Persona["length"], number> = { terse: 9, short: 14, medium: 22 };

export function cleanModelText(raw: string): string {
  return raw
    .replace(/[—–]/g, ", ") // no em/en dashes
    .replace(/^\s*[-*•]\s+/gm, "") // no bullets
    .replace(/\s*\n+\s*/g, " ")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "") // stray wrapping quotes
    .replace(/^[A-Za-z_ ]{1,20}:\s+/, "") // "riya: ..." speaker prefixes
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .trim();
}

const DANGLING = /\s+(and|or|but|so|when|if|because|cause|the|a|an|to|of|for|with|you|your|is|are|that|which|like|just|my|at|in|on)$/i;

/** Cap length without leaving a sentence hanging: prefer a clause boundary, never end on "and"/"when". */
export function capWords(text: string, max: number): string {
  const words = text.split(" ");
  if (words.length <= max + 3) return text; // a little slack beats a chopped sentence
  let cut = words.slice(0, max).join(" ");
  const clause = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (clause > cut.length * 0.45) cut = cut.slice(0, clause + 1);
  for (let i = 0; i < 3 && DANGLING.test(cut); i++) cut = cut.replace(DANGLING, "");
  return cut.replace(/[,;:]$/, "");
}

function transpose(word: string, random: () => number): string {
  const i = 1 + Math.floor(random() * (word.length - 2));
  return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
}

export function humanize(
  raw: string,
  persona: Persona,
  random: () => number = Math.random,
  opts: { oneWord?: boolean; maxWords?: number; noTypos?: boolean } = {},
): Humanized | null {
  let text = cleanModelText(raw);
  if (opts.oneWord) {
    text = (text.split(/\s+/)[0] ?? "").replace(/[,;:.]+$/, "");
    if (!text) return null;
    return { text: persona.lowercase ? text.toLowerCase() : text, correction: null };
  }
  text = capWords(text, opts.maxWords ?? MAX_WORDS[persona.length]);
  if (!text) return null;

  if (persona.lowercase) text = text.toLowerCase();
  // People in group chats rarely end with a full stop.
  if (text.endsWith(".") && !text.endsWith("...") && random() < 0.85) text = text.slice(0, -1);
  if (persona.lowercase && random() < 0.5) text = text.replace(/[.!]+$/, "");

  let correction: string | null = null;
  if (!opts.noTypos && random() < persona.typoRate) {
    const words = text.split(" ");
    const candidates = words.map((w, i) => ({ w, i })).filter(({ w }) => /^[a-zA-Z]{5,}$/.test(w));
    if (candidates.length > 0) {
      const { w, i } = candidates[Math.floor(random() * candidates.length)];
      const typo = transpose(w, random);
      if (typo !== w) {
        words[i] = typo;
        text = words.join(" ");
        if (random() < persona.correctsTypos) correction = `*${w}`;
      }
    }
  }
  return { text, correction };
}

/** Realistic think + type time for a message, in ms. */
export function typingDurationMs(text: string, persona: Persona, random: () => number = Math.random): number {
  // Phones are fast: about 1.6× the persona's base speed, capped so nobody "types" for ages.
  const base = (text.length / (persona.typingCps * 1.6)) * 1000;
  return Math.round(Math.min(6_000, Math.max(600, base * (0.8 + random() * 0.5))));
}

/** Word-overlap check so a bot never repeats or lightly rephrases its own line. */
export function tooSimilar(a: string, b: string): boolean {
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z\u0900-\u097f']{3,}/g) ?? []);
  const A = words(a);
  const B = words(b);
  if (A.size === 0 || B.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.7;
}
