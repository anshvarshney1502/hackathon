import { z } from "zod";
import { PlayerUidSchema } from "./ids";

/** CometChat stores an empty JSON object as `[]`. Normalise it back before validating. */
function emptyArrayAsObject(v: unknown): unknown {
  return Array.isArray(v) && v.length === 0 ? {} : v;
}

/**
 * LOBBY → CHAT (0–2 interrogation events) → TRUST → DEFENSE → VOTE → REVEAL → LOBBY.
 * Final Defense comes before the vote so a last plea can actually change verdicts.
 */
export const PHASES = ["LOBBY", "CHAT", "TRUST", "DEFENSE", "VOTE", "REVEAL"] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

export const VerdictSchema = z.enum(["HUMAN", "BOT"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const MAX_PLAYERS = 6;
/** There is always at least one AI at the table: at most five humans per case. */
export const MAX_HUMANS = MAX_PLAYERS - 1;
export const VOTE_SECONDS = 30;
export const TRUST_SECONDS = 20;
export const DEFENSE_SECONDS = 15;
export const DEFENSE_MAX_CHARS = 140;
export const CHAT_DURATIONS = [60, 120, 180, 300] as const;
export const DEFAULT_CHAT_SECONDS = 180;
export const ChatDurationSchema = z.union([
  z.literal(60),
  z.literal(120),
  z.literal(180),
  z.literal(300),
]);
/** Milliseconds each player is spotlighted during the reveal. */
export const REVEAL_STEP_MS = 5200;
/** The social read-out (most / least trusted) plays before the first spotlight. */
export const REVEAL_PREFACE_MS = 5000;

export const PlayerResultSchema = z.object({
  uid: PlayerUidSchema,
  name: z.string(),
  isBot: z.boolean(),
  votesHuman: z.number().int().min(0),
  votesBot: z.number().int().min(0),
  /** null when nobody voted on this player. */
  majorityCorrect: z.boolean().nullable(),
  /** Humans: correct guesses made. Bots: always 0. */
  correctGuesses: z.number().int().min(0),
  /** Humans: +2 when most humans read them as HUMAN. */
  humanBonus: z.number().int().min(0),
  /** Bots: number of human voters who called them HUMAN. */
  fooled: z.number().int().min(0),
  /** Bots: majority of human voters called them HUMAN. */
  botWon: z.boolean(),
  roundScore: z.number().int().min(0),
  voted: z.boolean(),
  /** Social stats (all deterministic counts, no LLM). Default 0 keeps older states parseable. */
  messages: z.number().int().min(0).default(0),
  trustMost: z.number().int().min(0).default(0),
  trustLeast: z.number().int().min(0).default(0),
  /** "Who feels most suspicious?" event picks received. */
  pointedAt: z.number().int().min(0).default(0),
  /** "Pick one player you believe is human" event picks received. */
  defendedBy: z.number().int().min(0).default(0),
  defended: z.boolean().default(false),
});
export type PlayerResult = z.infer<typeof PlayerResultSchema>;

export const RevealSchema = z.object({
  roundId: z.string(),
  botUids: z.array(PlayerUidSchema),
  salt: z.string(),
  revealedAt: z.number(),
  /** Spotlight order. */
  results: z.array(PlayerResultSchema),
  awards: z.array(
    z.object({
      kind: z.enum(["convincing_bot", "bot_like_human", "most_trusted", "biggest_suspect", "chaos_agent", "best_defense"]),
      uid: PlayerUidSchema,
      detail: z.string().max(80),
    }),
  ),
});
export type Reveal = z.infer<typeof RevealSchema>;
export type Award = Reveal["awards"][number];

/* ---------- interrogation events ---------- */

export const EVENT_TYPES = [
  "HOT_SEAT",
  "ONE_WORD",
  "POINT",
  "DEFEND",
  "RAPID_FIRE",
  "UNPOPULAR",
  "EVERYONE",
  "CROSS_EXAM",
  "CONTRADICTION",
  "MEMORY",
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const ActiveEventSchema = z.object({
  id: z.string().max(40),
  type: EventTypeSchema,
  prompt: z.string().max(160),
  targetUid: PlayerUidSchema.nullable(),
  /** Cross-examination: who asks the target. */
  examinerUid: PlayerUidSchema.nullable().default(null),
  /** Quoted chat lines the event is about (contradiction evidence). Public: everyone saw them. */
  evidence: z.array(z.string().max(160)).max(2).default([]),
  startedAt: z.number(),
  endsAt: z.number(),
});
export type ActiveEvent = z.infer<typeof ActiveEventSchema>;

/** Aggregate result of a pick event. Counts only: never who is a bot. */
export const EventResultSchema = z.object({
  id: z.string().max(40),
  type: EventTypeSchema,
  counts: z.preprocess(emptyArrayAsObject, z.record(PlayerUidSchema, z.number().int().min(0))),
  /** Memory check: who actually said the word (revealed when the event ends). */
  answerUid: PlayerUidSchema.nullable().default(null),
  /** Memory check: the word that was asked about. */
  cue: z.string().max(40).nullable().default(null),
  endedAt: z.number(),
});
export type EventResult = z.infer<typeof EventResultSchema>;

/**
 * Public game state. Stored by the server in CometChat group metadata under `nab`,
 * so late joiners can rebuild the game with a single `getGroup()`.
 * It never contains bot identities before REVEAL.
 */
export const GameStateSchema = z.object({
  v: z.literal(1),
  phase: PhaseSchema,
  seq: z.number().int().min(0),
  round: z.number().int().min(0),
  roundId: z.string().nullable(),
  topic: z.string().nullable(),
  phaseStartedAt: z.number(),
  endsAt: z.number().nullable(),
  chatSeconds: ChatDurationSchema,
  /** sha256(roundId|sorted bot uids|salt), published at round start, opened at reveal. */
  commitment: z.string().nullable(),
  /** Every seated player for this round (humans and bots, unlabelled). */
  roster: z.array(PlayerUidSchema),
  reveal: RevealSchema.nullable(),
  scores: z.preprocess(emptyArrayAsObject, z.record(z.string(), z.number().int())),
  /** Round alias per seated uid (public, random). The UI shows only these during a round. */
  aliases: z.preprocess(emptyArrayAsObject, z.record(PlayerUidSchema, z.string().max(24))).default({}),
  /** Lobby-only: an invitee could not get in (e.g. the CometChat user limit). Shown to the host. */
  lobbyNotice: z.object({ reason: z.enum(["player_limit"]), at: z.number(), count: z.number().int().min(1) }).nullable().default(null),
  /** When CHAT began this round (phaseStartedAt moves on with later phases). */
  roundStartedAt: z.number().default(0),
  /** Interrogation event currently running inside CHAT. */
  event: ActiveEventSchema.nullable().default(null),
  /** Events started this round (max 2). */
  eventsRun: z.number().int().min(0).default(0),
  /** Results of finished pick events this round. */
  eventLog: z.array(EventResultSchema).default([]),
});
export type GameState = z.infer<typeof GameStateSchema>;

export function initialGameState(now: number): GameState {
  return {
    v: 1,
    phase: "LOBBY",
    seq: 0,
    round: 0,
    roundId: null,
    topic: null,
    phaseStartedAt: now,
    endsAt: null,
    chatSeconds: DEFAULT_CHAT_SECONDS,
    commitment: null,
    roster: [],
    reveal: null,
    scores: {},
    aliases: {},
    lobbyNotice: null,
    roundStartedAt: 0,
    event: null,
    eventsRun: 0,
    eventLog: [],
  };
}

/* ---------- CometChat custom message payloads ---------- */

export const CUSTOM_TYPES = {
  phase: "game.phase",
  vote: "game.vote",
  reveal: "game.reveal",
  typing: "game.typing",
  trust: "game.trust",
  defense: "game.defense",
  pick: "game.pick",
  event: "game.event",
} as const;

export const PhaseEventSchema = z.object({
  seq: z.number().int(),
  phase: PhaseSchema,
  roundId: z.string().nullable(),
  endsAt: z.number().nullable(),
});
export type PhaseEvent = z.infer<typeof PhaseEventSchema>;

export const BallotsSchema = z.preprocess(
  emptyArrayAsObject,
  z.record(PlayerUidSchema, VerdictSchema).refine((b) => Object.keys(b).length <= MAX_PLAYERS, "Too many ballots"),
);
export type Ballots = z.infer<typeof BallotsSchema>;

export const VoteEventSchema = z.object({
  roundId: z.string().min(1).max(40),
  ballots: BallotsSchema,
});
export type VoteEvent = z.infer<typeof VoteEventSchema>;

export const TrustEventSchema = z
  .object({ roundId: z.string().min(1).max(40), most: PlayerUidSchema, least: PlayerUidSchema })
  .refine((t) => t.most !== t.least, "Most and least trusted must be different players");
export type TrustEvent = z.infer<typeof TrustEventSchema>;

export const DefenseEventSchema = z.object({
  roundId: z.string().min(1).max(40),
  text: z.string().trim().min(1).max(DEFENSE_MAX_CHARS),
});
export type DefenseEvent = z.infer<typeof DefenseEventSchema>;

export const PickEventSchema = z.object({
  roundId: z.string().min(1).max(40),
  eventId: z.string().min(1).max(40),
  pick: PlayerUidSchema,
});
export type PickEvent = z.infer<typeof PickEventSchema>;

/**
 * Private decisions (votes, trust, event picks) travel as sealed envelopes: ECDH P-256 + AES-GCM to a
 * server key. Other clients see *that* someone submitted, never *what*. See lib/game/sealed.ts.
 */
export const SealedBoxSchema = z.object({
  epk: z.string().min(40).max(200),
  iv: z.string().min(8).max(40),
  ct: z.string().min(8).max(4000),
});
export type SealedBox = z.infer<typeof SealedBoxSchema>;

export const SealedEnvelopeSchema = z.object({
  roundId: z.string().min(1).max(40),
  /** Only for event picks: which event the sealed pick belongs to. */
  eventId: z.string().min(1).max(40).optional(),
  sealed: SealedBoxSchema,
});
export type SealedEnvelope = z.infer<typeof SealedEnvelopeSchema>;

/** Sent with `game.event` when an interrogation event starts or ends. A nudge to re-sync. */
export const EventNudgeSchema = z.object({ seq: z.number().int() });

/**
 * Rich, post-reveal detail. Too large for group metadata (5 KB cap), so it travels in the
 * `game.reveal` custom message (10 KB data cap). Contains personas and objectives, so the
 * server only ever sends it at REVEAL.
 */
export const RevealDetailSchema = z.object({
  players: z.array(
    z.object({
      uid: PlayerUidSchema,
      archetype: z.string().max(40),
      /** Who was behind the alias: a human's account name. Null for bots (their persona shows instead). */
      realName: z.string().max(40).nullable(),
      /** Bots only: the AI persona that was playing the seat. */
      personaName: z.string().max(30).nullable().default(null),
      /** Seats whose holder trusted this player most (post-reveal social consequence). */
      trustedBy: z.array(PlayerUidSchema).max(6),
      /** Human voters who called this player HUMAN. */
      humansSaidHuman: z.number().int().min(0),
      persona: z.object({ line: z.string().max(80), traits: z.array(z.string().max(30)).max(4) }).nullable(),
      objective: z
        .object({ title: z.string().max(90), status: z.enum(["COMPLETED", "FAILED"]) })
        .nullable(),
      defense: z.string().max(DEFENSE_MAX_CHARS).nullable(),
    }),
  ),
});
export type RevealDetail = z.infer<typeof RevealDetailSchema>;

export const RevealEventSchema = z.object({
  seq: z.number().int(),
  roundId: z.string(),
  detail: RevealDetailSchema.optional(),
});

export const TypingEventSchema = z.object({
  ms: z.number().int().min(200).max(20000),
});
