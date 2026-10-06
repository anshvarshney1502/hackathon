/**
 * Cheap, deterministic conversation signals. They power objective checks, bot trust,
 * bot votes and awards, so none of those need an LLM call.
 */
export interface Line {
  uid: string;
  name: string;
  text: string;
}

export function firstName(name: string): string {
  return name.trim().toLowerCase().split(/[\s_]+/)[0] ?? "";
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentions(text: string, name: string): boolean {
  const f = firstName(name);
  return f.length >= 2 && new RegExp(`(^|[^a-z0-9])@?${escape(f)}([^a-z0-9]|$)`, "i").test(text);
}

const ACCUSE = /\b(bot|bots|ai|robot|chatgpt|gpt|fake|sus|suspicious|sussy|npc|scripted|llm)\b/i;
const DISAGREE = /\b(nah|nope|no way|disagree|wrong|not really|hard disagree|cap|ok but|okay but|cope|fight me|hell no|bs)\b/i;
const AGREE = /\b(same|agreed|agree|true|exactly|fr|facts|so true|right|yes|yess|valid|fair|correct|real)\b/i;
const LAUGH = /(\blol+\b|\bhaha+\b|\blmao+\b|\blmfao\b|\bdead\b|😂|🤣|💀|\bhehe\b|\brofl\b)/i;
const VOUCH = /(\b(is|seems|def|definitely|totally|prob|probably|clearly|100%)\s+(a\s+)?(human|real|legit|normal)\b|\bnot a bot\b|\bi trust\b|\bvouch)/i;
const PREFERENCE = /\b(i (really )?(like|love|hate|prefer|can't stand|cant stand|adore)|my (fav|favourite|favorite)|i'?m (a|more of a)|team \w+)\b/i;

export const isQuestion = (t: string) => t.includes("?");
export const isAccusation = (t: string) => ACCUSE.test(t);
export const isDisagreement = (t: string) => DISAGREE.test(t);
export const isAgreement = (t: string) => AGREE.test(t);
export const isLaugh = (t: string) => LAUGH.test(t);
export const isPreference = (t: string) => PREFERENCE.test(t);
export const isVouch = (t: string) => VOUCH.test(t);
/** "I'm literally a bot" / "ok fine i'm the AI": bluffs and jokes about yourself, not accusations. */
const SELF_CLAIM = /\bi'?m\s+(literally\s+|actually\s+|totally\s+|definitely\s+|so\s+)?(a\s+|an\s+|the\s+)?(bot|ai|robot|npc)\b|\bi am (a |an |the )?(bot|ai|robot)\b/i;
export const isSelfClaim = (t: string) => SELF_CLAIM.test(t);

export interface SocialSignals {
  messages: Record<string, number>;
  avgLength: Record<string, number>;
  /** accusations[from][to]: `from` called `to` a bot / sus. */
  accusations: Record<string, Record<string, number>>;
  /** mentions[from][to]: `from` addressed `to` by name. */
  mentions: Record<string, Record<string, number>>;
  /** Accusations + disagreements made, for the Chaos Agent award. */
  disruptions: Record<string, number>;
  /** vouches[from][to]: `from` said `to` is human / trustworthy. */
  vouches: Record<string, Record<string, number>>;
  /** Players who claimed (or joked) that they themselves are a bot. */
  selfClaims: Record<string, number>;
}

/** Who is the line probably about? A named player, else the previous speaker. */
export function targetsOf(line: Line, prev: Line | undefined, roster: { uid: string; name: string }[]): string[] {
  const named = roster.filter((p) => p.uid !== line.uid && mentions(line.text, p.name)).map((p) => p.uid);
  if (named.length) return named;
  return prev && prev.uid !== line.uid ? [prev.uid] : [];
}

export function socialSignals(lines: Line[], roster: { uid: string; name: string }[]): SocialSignals {
  const s: SocialSignals = { messages: {}, avgLength: {}, accusations: {}, mentions: {}, disruptions: {}, vouches: {}, selfClaims: {} };
  lines.forEach((line, i) => {
    const n = s.messages[line.uid] ?? 0;
    s.avgLength[line.uid] = ((s.avgLength[line.uid] ?? 0) * n + line.text.length) / (n + 1);
    s.messages[line.uid] = n + 1;
    const targets = targetsOf(line, lines[i - 1], roster);
    for (const t of roster) {
      if (t.uid !== line.uid && mentions(line.text, t.name)) {
        (s.mentions[line.uid] ??= {})[t.uid] = (s.mentions[line.uid]?.[t.uid] ?? 0) + 1;
      }
    }
    // "X is definitely human" is a vouch, not an accusation, even though it says "bot"-adjacent words.
    const vouch = isVouch(line.text);
    if (isSelfClaim(line.text)) {
      s.selfClaims[line.uid] = (s.selfClaims[line.uid] ?? 0) + 1;
      return; // a bluff about yourself accuses nobody else
    }
    if (vouch) {
      for (const t of targets) (s.vouches[line.uid] ??= {})[t] = (s.vouches[line.uid]?.[t] ?? 0) + 1;
    }
    if (!vouch && isAccusation(line.text)) {
      for (const t of targets) (s.accusations[line.uid] ??= {})[t] = (s.accusations[line.uid]?.[t] ?? 0) + 1;
    }
    if (isAccusation(line.text) || isDisagreement(line.text)) {
      s.disruptions[line.uid] = (s.disruptions[line.uid] ?? 0) + 1;
    }
  });
  return s;
}

/** Total accusations a player received. */
export function accusationsAgainst(sig: SocialSignals, uid: string): number {
  return Object.values(sig.accusations).reduce((sum, row) => sum + (row[uid] ?? 0), 0);
}
