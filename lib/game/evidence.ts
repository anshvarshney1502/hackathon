import type { Line } from "./signals";

/**
 * Deterministic evidence mining over the chat. No LLM: a contradiction is only ever claimed
 * when the same player said they love X and, separately, that they hate X.
 */

const POSITIVE = /\bi\s+(really\s+|absolutely\s+|honestly\s+)?(love|like|adore|enjoy)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)/i;
const NEGATIVE = /\bi\s+(really\s+|absolutely\s+|honestly\s+)?(hate|dislike|can'?t stand|don'?t like|despise)\s+([a-z][a-z'-]+(?:\s+[a-z][a-z'-]+)?)/i;
const FILLER = new Set(["it", "that", "this", "them", "you", "u", "how", "when", "the", "a", "an", "to", "my", "being", "people"]);

function subject(phrase: string): string | null {
  const words = phrase.toLowerCase().split(/\s+/).filter((w) => !FILLER.has(w));
  const w = words[0]?.replace(/s$/, "");
  return w && w.length >= 3 ? w : null;
}

export interface Contradiction {
  uid: string;
  name: string;
  earlier: string;
  later: string;
}

/** The most recent genuine love/hate flip on the same subject by the same player, if any. */
export function findContradiction(lines: Line[]): Contradiction | null {
  const seen = new Map<string, { sign: 1 | -1; text: string }>(); // `${uid}|${subject}`
  let found: Contradiction | null = null;
  for (const l of lines) {
    const pos = l.text.match(POSITIVE);
    const neg = l.text.match(NEGATIVE);
    if ((pos && neg) || (!pos && !neg)) continue; // mixed or no stance: not evidence
    const sign: 1 | -1 = pos ? 1 : -1;
    const subj = subject(((pos ?? neg) as RegExpMatchArray)[3]);
    if (!subj) continue;
    const key = `${l.uid}|${subj}`;
    const prev = seen.get(key);
    if (prev && prev.sign !== sign) found = { uid: l.uid, name: l.name, earlier: prev.text, later: l.text };
    seen.set(key, { sign, text: l.text });
  }
  return found;
}

const STOP = new Set(
  "about above after again against because before being below between could doing during every going gonna honestly literally really should something their there these thing things think those through under until wanna where which while would always actually anyone anything everyone people pretty probably someone sometimes basically definitely totally".split(" "),
);

export interface MemoryCue {
  word: string;
  uid: string;
}

/**
 * A word exactly one player used (once, or several times themselves): "Who mentioned INTERSTELLAR?"
 * Prefers longer, rarer words; skips the topic's own words and common filler.
 */
export function findMemoryCue(lines: Line[], topic: string, random: () => number): MemoryCue | null {
  const topicWords = new Set(topic.toLowerCase().match(/[a-z]+/g) ?? []);
  const owners = new Map<string, Set<string>>();
  for (const l of lines.slice(0, Math.max(0, lines.length - 3))) {
    for (const raw of l.text.toLowerCase().match(/[a-z]{5,}/g) ?? []) {
      if (STOP.has(raw) || topicWords.has(raw)) continue;
      (owners.get(raw) ?? owners.set(raw, new Set()).get(raw))?.add(l.uid);
    }
  }
  const unique = [...owners.entries()].filter(([, who]) => who.size === 1).sort((a, b) => b[0].length - a[0].length);
  if (unique.length === 0) return null;
  const pick = unique[Math.floor(random() * Math.min(4, unique.length))];
  return { word: pick[0], uid: [...pick[1]][0] };
}
