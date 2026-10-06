import { seededRandom, shuffled } from "@/lib/game/rng";
import { isAgreement, isDisagreement, isLaugh, isPreference, isQuestion, type Line, mentions } from "@/lib/game/signals";

/**
 * Secret bot objectives. Server-only: assignments are derived from a server-secret seed,
 * so nothing has to be stored or sent to clients before REVEAL.
 *
 * Every objective has an observable success condition, so completion is judged with
 * deterministic checks over the transcript, trust picks and votes. No LLM call is needed.
 */
export type ObjectiveKind =
  | "ASKED_A_QUESTION"
  | "DISAGREE_ONCE"
  | "MENTION_WORD"
  | "FRAME_TARGET"
  | "FOOL_ONE"
  | "GET_DEFENDED"
  | "GET_AGREEMENT"
  | "MAKE_LAUGH"
  | "DRAW_PREFERENCE"
  | "MINI_ARGUMENT"
  | "BE_TRUSTED";

export type ObjectiveStatus = "IN_PROGRESS" | "COMPLETED" | "FAILED";

export interface BotObjective {
  id: ObjectiveKind;
  title: string;
  /** What the bot is told (incentive, never a script). */
  description: string;
  difficulty: "easy" | "medium" | "hard";
  params: { word?: string; targetUid?: string; targetName?: string };
}

const WORDS = ["biryani", "monsoon", "cricket", "your cousin's wedding", "a cat", "Maggi", "the metro", "an ex", "dentists", "Shah Rukh"];

type Template = Omit<BotObjective, "params" | "title" | "description"> & {
  title: (p: BotObjective["params"]) => string;
  description: (p: BotObjective["params"]) => string;
  needs?: "word" | "target";
};

const TEMPLATES: Template[] = [
  { id: "ASKED_A_QUESTION", difficulty: "easy", title: () => "Get someone to ask you a question.", description: () => "Be interesting enough that another player asks you something directly, using your name." },
  { id: "DISAGREE_ONCE", difficulty: "easy", title: () => "Disagree with another player at least once.", description: () => "Push back on someone's take at least once. Casually, the way friends do." },
  { id: "MENTION_WORD", difficulty: "medium", needs: "word", title: (p) => `Bring up ${p.word} naturally.`, description: (p) => `Work "${p.word}" into the conversation without it feeling forced.` },
  { id: "FRAME_TARGET", difficulty: "hard", needs: "target", title: (p) => `Make ${p.targetName} look suspicious.`, description: (p) => `Nudge the room to doubt ${p.targetName}. Subtle, never obvious, never mean.` },
  { id: "FOOL_ONE", difficulty: "medium", title: () => "Convince at least one human you are human.", description: () => "Be relatable and specific so at least one person believes you're real." },
  { id: "GET_DEFENDED", difficulty: "hard", title: () => "Get another player to defend you.", description: () => "Make someone want to vouch for you or trust you most." },
  { id: "GET_AGREEMENT", difficulty: "medium", title: () => "Get another player to agree with you.", description: () => "Say something people nod along to. Get an 'same' or 'true' out of someone." },
  { id: "MAKE_LAUGH", difficulty: "medium", title: () => "Make someone laugh.", description: () => "Land a joke or a funny detail that gets a 'lol' from another player." },
  { id: "DRAW_PREFERENCE", difficulty: "medium", title: () => "Get another player to reveal a personal preference.", description: () => "Ask something that gets someone to say what they like, love or hate." },
  { id: "MINI_ARGUMENT", difficulty: "hard", title: () => "Start a mini-argument without becoming the main suspect.", description: () => "Spark a small, friendly disagreement, then don't be the person everyone suspects." },
  { id: "BE_TRUSTED", difficulty: "hard", title: () => "Be someone's most trusted player.", description: () => "Be warm and consistent so a human picks you as the one they trust most." },
];

/** One objective per bot, all different within a round. Deterministic for a given seed. */
export function assignObjectives(
  seed: string,
  botUids: string[],
  roster: { uid: string; name: string }[],
): Record<string, BotObjective> {
  const random = seededRandom(`objectives:${seed}`);
  const kinds = shuffled(TEMPLATES, random);
  const out: Record<string, BotObjective> = {};
  botUids.forEach((uid, i) => {
    const t = kinds[i % kinds.length];
    const params: BotObjective["params"] = {};
    if (t.needs === "word") params.word = WORDS[Math.floor(random() * WORDS.length)];
    if (t.needs === "target") {
      const others = roster.filter((p) => p.uid !== uid);
      const target = others[Math.floor(random() * others.length)];
      params.targetUid = target?.uid;
      params.targetName = target?.name;
    }
    out[uid] = { id: t.id, difficulty: t.difficulty, title: t.title(params), description: t.description(params), params };
  });
  return out;
}

export interface ObjectiveContext {
  botUid: string;
  botName: string;
  /** Chat-phase transcript, oldest first. */
  lines: Line[];
  /** Available only at reveal. */
  final?: {
    /** Humans who called this bot HUMAN. */
    fooled: number;
    /** Trust-most picks received from anyone else. */
    trustMostFromOthers: number;
    /** Trust-most picks received from humans. */
    trustMostFromHumans: number;
    /** DEFEND-event picks received. */
    defendedBy: number;
    /** BOT votes / HUMAN votes / trust-least / point picks received by the frame target. */
    target?: { votesBot: number; votesHuman: number; trustLeast: number; pointedAt: number };
    /** True when this bot received the most BOT votes of anyone. */
    isTopSuspect: boolean;
  };
}

/** Index of lines written by others within `window` lines after one of the bot's lines. */
function repliesTo(lines: Line[], botUid: string, window: number, test: (l: Line) => boolean): boolean {
  return lines.some((l, i) => {
    if (l.uid !== botUid) return false;
    return lines.slice(i + 1, i + 1 + window).some((r) => r.uid !== botUid && test(r));
  });
}

function chatCheck(o: BotObjective, ctx: ObjectiveContext): boolean {
  const mine = ctx.lines.filter((l) => l.uid === ctx.botUid);
  const others = ctx.lines.filter((l) => l.uid !== ctx.botUid);
  switch (o.id) {
    case "ASKED_A_QUESTION":
      return others.some((l) => isQuestion(l.text) && mentions(l.text, ctx.botName));
    case "DISAGREE_ONCE":
      return mine.some((l) => isDisagreement(l.text));
    case "MENTION_WORD": {
      const w = (o.params.word ?? "").toLowerCase().replace(/^(a|an|the|your)\s+/, "").split(/\s|'/)[0];
      return w.length > 1 && mine.some((l) => l.text.toLowerCase().includes(w));
    }
    case "GET_AGREEMENT":
      return repliesTo(ctx.lines, ctx.botUid, 2, (r) => isAgreement(r.text));
    case "MAKE_LAUGH":
      return repliesTo(ctx.lines, ctx.botUid, 3, (r) => isLaugh(r.text));
    case "DRAW_PREFERENCE":
      return ctx.lines.some(
        (l, i) =>
          l.uid === ctx.botUid &&
          isQuestion(l.text) &&
          ctx.lines.slice(i + 1, i + 4).some((r) => r.uid !== ctx.botUid && isPreference(r.text)),
      );
    case "MINI_ARGUMENT":
      return ctx.lines.some(
        (l, i) =>
          l.uid === ctx.botUid &&
          isDisagreement(l.text) &&
          ctx.lines.slice(i + 1, i + 4).some((r) => r.uid !== ctx.botUid && isDisagreement(r.text)),
      );
    default:
      return false;
  }
}

/** Live status for the bot's own prompt (so it stops pushing once done). */
export function objectiveProgress(o: BotObjective, ctx: ObjectiveContext): ObjectiveStatus {
  return chatCheck(o, ctx) ? "COMPLETED" : "IN_PROGRESS";
}

/** Final verdict at REVEAL. Anything not achieved by then failed. */
export function evaluateObjective(o: BotObjective, ctx: ObjectiveContext): Exclude<ObjectiveStatus, "IN_PROGRESS"> {
  const f = ctx.final;
  switch (o.id) {
    case "FOOL_ONE":
      return f && f.fooled >= 1 ? "COMPLETED" : "FAILED";
    case "BE_TRUSTED":
      return f && f.trustMostFromHumans >= 1 ? "COMPLETED" : "FAILED";
    case "GET_DEFENDED":
      return f && (f.trustMostFromOthers >= 1 || f.defendedBy >= 1) ? "COMPLETED" : "FAILED";
    case "FRAME_TARGET": {
      const t = f?.target;
      return t && (t.votesBot > t.votesHuman || t.trustLeast + t.pointedAt >= 1) ? "COMPLETED" : "FAILED";
    }
    case "MINI_ARGUMENT":
      return chatCheck(o, ctx) && !(f?.isTopSuspect ?? false) ? "COMPLETED" : "FAILED";
    default:
      return chatCheck(o, ctx) ? "COMPLETED" : "FAILED";
  }
}

