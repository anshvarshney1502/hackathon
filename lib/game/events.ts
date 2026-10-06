import { EVENT_TAIL_MS } from "./machine";
import { seededRandom, shuffled } from "./rng";
import type { Contradiction, MemoryCue } from "./evidence";
import type { ActiveEvent, EventType } from "./types";

export interface EventSpec {
  title: string;
  /** Short line under the title. */
  instruction: string;
  durationMs: number;
  /** "chat": answered in the group chat. "pick": everyone picks a player. */
  mode: "chat" | "pick";
  /** Needs a target player. */
  targeted?: boolean;
  /** Needs evidence mined from the chat (only possible later in a round). */
  needsEvidence?: boolean;
}

export const EVENT_SPECS: Record<EventType, EventSpec> = {
  HOT_SEAT: { title: "Hot seat", instruction: "They have to answer. Everyone else: watch how.", durationMs: 25_000, mode: "chat", targeted: true },
  ONE_WORD: { title: "One word only", instruction: "Answer the topic in a single word.", durationMs: 15_000, mode: "chat" },
  POINT: { title: "Point at someone", instruction: "Who feels the most suspicious right now?", durationMs: 15_000, mode: "pick" },
  DEFEND: { title: "Defend someone", instruction: "Pick one player you believe is human.", durationMs: 15_000, mode: "pick" },
  RAPID_FIRE: { title: "Rapid fire", instruction: "10 seconds. Answer immediately.", durationMs: 10_000, mode: "chat" },
  UNPOPULAR: { title: "Unpopular opinion", instruction: "Drop one genuinely unpopular opinion.", durationMs: 25_000, mode: "chat" },
  EVERYONE: { title: "Everyone answers", instruction: "Same question for everyone. Compare the answers.", durationMs: 25_000, mode: "chat" },
  CROSS_EXAM: { title: "Cross-examination", instruction: "One question. One answer. Everyone else watches.", durationMs: 25_000, mode: "chat", targeted: true },
  CONTRADICTION: { title: "Contradiction detected", instruction: "Same player, opposite story. Explain yourself.", durationMs: 25_000, mode: "chat", needsEvidence: true },
  MEMORY: { title: "Memory check", instruction: "Pick the player who said it.", durationMs: 15_000, mode: "pick", needsEvidence: true },
};

/** Hot seat questions: short, concrete, hard to answer generically. */
const HOT_SEAT_PROMPTS = [
  "Describe your perfect Sunday in exactly 7 words.",
  "What's one thing you would never do for money?",
  "You have $10,000. What's the first thing you buy?",
  "Answer without using the word 'I': what did you do yesterday?",
  "Defend the player you trust the LEAST.",
  "What's the last thing you were genuinely wrong about?",
];

const EVERYONE_PROMPTS = [
  "What's one movie you could watch 10 times?",
  "What's a smell that instantly takes you back somewhere?",
  "What's the most useless thing you own but won't throw away?",
  "Which app would you delete first if you had to?",
  "What did you want to be when you were 10?",
];

const RAPID_PROMPTS = [
  "Tea or coffee? Go.",
  "Last thing you ate?",
  "Window seat or aisle?",
  "Dogs or cats?",
  "Morning person or night owl?",
  "Most used app on your phone?",
  "What did you do last Sunday?",
];

export interface PlannedEvent {
  type: EventType;
  /** Offset from chat start. */
  atMs: number;
}

/**
 * 0–2 events per round, at irregular moments, always finishing well before chat ends.
 * Seeded by the server secret + round id, so the schedule is stable but unknowable to clients.
 */
export function planEvents(seed: string, chatSeconds: number, rosterSize: number): PlannedEvent[] {
  const random = seededRandom(`events:${seed}`);
  const chatMs = chatSeconds * 1000;
  const roll = random();
  // Every round gets at least one event: chat alone gets stale. Longer rounds get two.
  const count = chatSeconds <= 60 ? 1 : chatSeconds <= 120 ? (roll < 0.5 ? 1 : 2) : roll < 0.2 ? 1 : 2;
  const all = (Object.keys(EVENT_SPECS) as EventType[]).filter((t) => !EVENT_SPECS[t].targeted || rosterSize >= 3);
  // Evidence events need chat to mine, so they only ever take the later slot.
  const early = shuffled(all.filter((t) => !EVENT_SPECS[t].needsEvidence), random);
  const late = shuffled(all, random);
  const windows = count === 1 ? [[0.35, 0.55]] : [[0.2, 0.33], [0.55, 0.68]];
  const out: PlannedEvent[] = [];
  for (let i = 0; i < count; i++) {
    const pool = i === 0 ? early : late;
    const [lo, hi] = windows[i];
    const want = Math.round(chatMs * (lo + random() * (hi - lo)));
    const latest = chatMs - EVENT_TAIL_MS - 2_000;
    const earliest = Math.max(8_000, (out.at(-1)?.atMs ?? 0) + (out.at(-1) ? EVENT_SPECS[out.at(-1)!.type].durationMs + 5_000 : 0));
    // Pull the event earlier if it would run into the end of chat; skip types that can't fit at all.
    const type = pool.find((t) => !out.some((o) => o.type === t) && latest - EVENT_SPECS[t].durationMs >= earliest);
    if (!type) continue;
    const atMs = Math.max(earliest, Math.min(want, latest - EVENT_SPECS[type].durationMs));
    out.push({ type, atMs });
  }
  return out;
}

export function buildEvent(
  type: EventType,
  seed: string,
  index: number,
  now: number,
  roster: { uid: string; name: string }[],
  topic: string,
  evidence: { contradiction?: Contradiction | null; memory?: MemoryCue | null } = {},
): ActiveEvent {
  const random = seededRandom(`event:${seed}:${index}`);
  const spec = EVENT_SPECS[type];
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
  let target = spec.targeted ? roster[Math.floor(random() * roster.length)] : undefined;
  let examiner: { uid: string; name: string } | undefined;
  let prompt: string = spec.instruction;
  let quotes: string[] = [];

  switch (type) {
    case "HOT_SEAT":
      prompt = `${target?.name}, you're up. ${pick(HOT_SEAT_PROMPTS)}`;
      break;
    case "ONE_WORD":
      prompt = `ONE WORD ONLY. "${topic}" in one word.`;
      break;
    case "RAPID_FIRE":
      prompt = pick(RAPID_PROMPTS);
      break;
    case "EVERYONE":
      prompt = pick(EVERYONE_PROMPTS);
      break;
    case "CROSS_EXAM": {
      const others = roster.filter((p) => p.uid !== target?.uid);
      examiner = others[Math.floor(random() * others.length)];
      prompt = `${examiner?.name} questions ${target?.name}. Ask one thing. ${target?.name}: answer it.`;
      break;
    }
    case "CONTRADICTION": {
      const c = evidence.contradiction;
      target = c ? { uid: c.uid, name: c.name } : undefined;
      prompt = `${c?.name} said two different things. ${c?.name}: which one is true?`;
      quotes = c ? [`Earlier: "${c.earlier}"`, `Later: "${c.later}"`].map((q) => q.slice(0, 160)) : [];
      break;
    }
    case "MEMORY":
      prompt = `Who mentioned ${(evidence.memory?.word ?? "it").toUpperCase()} earlier?`;
      break;
  }
  return {
    id: `${seed.slice(0, 6)}-${index}`,
    type,
    prompt: prompt.slice(0, 160),
    targetUid: target?.uid ?? null,
    examinerUid: examiner?.uid ?? null,
    evidence: quotes,
    startedAt: now,
    endsAt: now + spec.durationMs,
  };
}

/** One-word rule shared by the input validator and the bot humanizer. */
export function isOneWord(text: string): boolean {
  return /^\S+$/.test(text.trim().replace(/[.!?…]+$/, ""));
}
