# Decisions

Each entry: the choice, why, and what was rejected. CometChat facts are sourced in [MCP_LOG.md](./MCP_LOG.md).

## D1. The server owns the secret and the clock. The host owns the tempo.

The brief asks for a host-authoritative state machine and a secret bot roster. Taken literally, those two conflict: if the
host's browser picks the bots, the host knows who the bots are, which is fatal in a multi-human game.

**Decision.** The host client *drives* transitions (it decides when to start, ends chat early, and fires the timer-based moves).
Every transition goes through `POST /api/rooms/[id]/advance`. The server validates it against the pure state machine
(`lib/game/machine.ts`), chooses the bots, and writes the new state into the CometChat group metadata. Then it posts a `game.phase`
custom message as the host.

- Clients treat `game.phase` / `game.reveal` events as a nudge only and re-read the group metadata. Participants cannot write group
  metadata, so a forged event cannot change the game.
- Time-based moves (chat → vote, vote → reveal) are accepted from any seated human once the absolute deadline has passed. A stalled
  or departed host can't freeze the game. Structural moves (start, reset, end early) require the elected host.
- `expectSeq` makes every transition idempotent: a duplicate call returns the current state.

## D2. No database. CometChat group metadata is the store.

The whole public game state (phase, absolute `endsAt`, topic, roster, commitment, reveal, scores) lives in the room group's
`metadata.nab`, validated by `GameStateSchema`. A late joiner rebuilds the game with one `getGroup()` plus message history. Votes are
`game.vote` custom messages, and the server reads them back from CometChat history at reveal time.

Quirk found in testing: CometChat stores an empty JSON object as `[]`. Schemas normalise `[]` back to `{}` (see the regression test in
`tests/machine.test.ts`).

## D3. Bots are identified only by a server secret

The 12 pooled bot users have UIDs derived as `p-` + HMAC(SESSION_SECRET, index). Human UIDs are `p-` + 12 random chars from the same
alphabet, so the two are indistinguishable. Nothing on the client knows which members are bots: not the state, not props, not
storage. The server recomputes the pool from the secret whenever it needs it.

**Commit/reveal.** At round start the server publishes `sha256(roundId | sorted bot uids | salt)`. The salt is also HMAC-derived, so
nothing needs storing. At reveal it publishes the uids and salt, and every client verifies the hash in the browser
(`lib/game/commitment.ts`). The UI states whether verification passed.

## D4. Indistinguishable seating

- Humans and bots are both added to the private group by the server through the REST API, so every seat produces the same
  `added by app_system` action. Humans never `joinGroup` themselves.
- In the lobby, strangers drift in at irregular intervals (host-driven `/fill`, probabilistic, at least 4 s apart), keeping one chair free
  for friends. If a human arrives at a full table, a bot "gets up" to make room.
- A seat UI never shows raw presence for others (bots have no socket and would always look offline). It only shows "signal lost" when a
  member is *observed* going offline.

**Known side channels (documented, not hidden).** A determined player with devtools can still infer some things from CometChat's own
payloads (for example the `status` field inside message sender entities, or noticing that the pooled names repeat across games). The game's
own APIs, state and props never leak the roster. Fully hiding transport metadata would require bots to hold real sockets, which needs a
long-running server. That is out of scope on Vercel Hobby.

## D5. Bot responses: short-lived planning with `after()`, never a loop

`POST /api/bots/plan` (debounced, called by the host after messages and during silences) returns immediately. Inside `after()` the server:
1. reads the transcript **from CometChat**, not from the client, so it cannot be forged and the client never handles bot identities,
2. picks 1–3 candidate speakers (talkativeness, recency, anyone addressed by name),
3. asks the LLM for `{replies:[{bot,message,thinkTimeMs}]}` (Zod-validated, one retry, then skip),
4. humanises each line in code (persona casing, length cap, typos with optional `*fix`, no em dashes),
5. moderates it, sends `game.typing` as the bot, waits a realistic typing time, then sends the text as the bot via REST `onBehalfOf`.

Guards: at most 2 replies per plan, the second staggered by at least 2.5 s. Never more than 2 bot lines in a row without a human. A
per-round budget of about 9 bot lines per chat minute. Per-trigger dedupe. Per-user and per-room rate limits. A final "still in CHAT?" check
before each send. Route `maxDuration` is 60 s.

The brief suggested sending transcript, bot list and game state in the request. That was rejected: it would put bot identities in a client
payload. The endpoint keeps the requested path and contract (room id in, plan out on the server).

## D6. Bot typing indicators

The MCP search found no REST endpoint for typing; typing is SDK-only. Bots therefore emit a `game.typing` custom message (with an
expected duration). The client merges it with native `onTypingStarted/Ended` into one typing state. Humans use the real SDK indicators.

## D7. Bot votes: heuristics, not the LLM

Bots vote from surface signals (silence, long messages, hyperactivity), their persona's paranoia, and noise. They are never told who the
bots are, so they make believable mistakes. It is also free and instant.

## D8. Moderation

CometChat dashboard moderation may not be part of the free Build plan, so nothing depends on it. Bot output is filtered server-side
(`lib/moderation.ts`). Slurs, sexual content and AI self-disclosure drop the line (fail closed). Gemini safety settings are strict as a second
layer. Humans can Report a message: this calls `CometChat.flagMessage`, and if that fails it falls back to `/api/report` (server log). If
dashboard moderation is enabled, it also applies to human messages.

## D9. Identity

`POST /api/session` creates the user with the REST key and returns a fresh Auth Token, plus an HMAC-signed `sessionToken` proving
uid ownership. The browser stores only `{uid, name, sessionToken}`. Reusing the token on refresh keeps the same CometChat user, so it
doesn't burn MAU. The Auth Key is never sent to the browser.

## D10. Scoring semantics

- Human: +1 per correct label. +2 if most *human* voters (excluding themselves) labelled them HUMAN. A tie is not "most".
- Bot wins if most human voters labelled it HUMAN. "Fooled" = number of humans who said HUMAN.
- "Majority correct" counts every ballot received, bots included (bots vote too).
- Awards rank by ratio, then raw count, then uid, so every client derives the same winner.

## D11. Visual system

One accent (sodium amber `#F2A33A`) on warm ink. Barlow Condensed for display, JetBrains Mono for everything else. Paper case files
and inked stamps for voting. The `ui-ux-pro-max` design database suggested a generic SaaS pattern (hero + features + green palette), which
the brief explicitly forbids. Only its accessibility and motion checklist was adopted.

## D12. One persistent 3D scene

The R3F canvas lives in the root layout, so it survives navigation from landing to room. Pages drive it through a tiny external store
(`lib/client/sceneStore.ts`). The canvas is lazy-loaded with `ssr: false` and a DPR capped at 1.5 (dropped to 1 by drei's `PerformanceMonitor`).
`frameloop` is `never` while the tab is hidden. It uses low-poly geometry, one spotlight, and a baked contact shadow texture. Name tags are canvas
textures, so no font fetch is needed. A 2D fallback is used without WebGL, on low-memory or low-core devices, or after a context loss.
Reduced motion disables sway, glitch and camera easing.

---

# Gameplay upgrade (round 2 of development)

Five systems were added on top of the existing loop, reusing its sync path: server-written group metadata, plus `game.*` custom messages as nudges and submissions.

## D13. Phase order: CHAT → TRUST → DEFENSE → VOTE → REVEAL

Final Defense comes **before** the vote. A plea made after the verdicts are filed can't change anything, which makes it theatre rather than
gameplay. Pleading first means every last line shows on the suspect's case file while you stamp it, so a good defense can swing votes.
Trust comes before the defense, as a gut read from the conversation that the defenses then try to overturn. Durations: Trust 20 s,
Defense 15 s, Vote 30 s. Trust, Defense and Vote end early once every seated player has submitted (the server re-checks).

Interrogation events are **not** a phase. They live inside CHAT (`state.event`), so they never move the chat deadline, and a
missed heartbeat can't break a round.

## D14. Secret objectives are derived, judged deterministically, and published only at reveal

- Assignment: `assignObjectives(HMAC(secret, roundId), bots, roster)`. One per bot, all different. Nothing is stored and nothing reaches a client
  before REVEAL. Some objectives carry a parameter (a word to slip in, or a player to frame).
- Every objective was chosen to have an **observable** success condition, so completion uses deterministic checks over the transcript,
  trust picks, event picks and votes (`lib/bots/objectives.ts`, built on `lib/game/signals.ts`). No objective needs an LLM to judge it.
  We chose this over "LLM as judge" because it is free, instant, testable and not open to prompt injection from chat.
- Bots receive the objective as a soft incentive inside their private situation, along with live progress so they stop pushing once it is done.
  The prompt says to stay believable first and to ignore the objective if pursuing it would look odd. Moderation drops any line that mentions
  "objective", "side goal" or "the prompt".

## D15. Trust most / least

A `game.trust` custom message `{roundId, most, least}`, validated by Zod (most ≠ least, never yourself). The last pick counts. Bots choose
from conversation affinity (who addressed them, who accused them, who was silent, and how paranoid the persona is). A seeded jitter only
breaks near-ties, so the choices read as judgements, not dice. Trust is shown at reveal as a social preface (most and least trusted, with
bars) and feeds the Most Trusted award. It also nudges bot votes slightly, the way room mood sways people.

## D16. Final defense

`game.defense` `{roundId, text ≤ 140}`. **The first message per player wins**, enforced on the client (the button locks before sending,
and refresh restores the lock from history) and on the server (`collectRound(…, "first")`). Free chat is closed during the defense. All bot
defenses come from one dedicated LLM call. It is not the chat planner: it gets persona, transcript, heat (accusations and trust-least picks),
objective, and an assigned tone per bot (confident / joking / defensive / slightly suspicious / extremely casual), so the pleas differ. If the
model fails or a line is moderated, an in-character fallback is used, so every bot submits exactly one defense. Disconnected humans simply
have "No statement."

## D17. Interrogation events

- The schedule comes from `planEvents(HMAC(secret, roundId))`: 0–2 events, at irregular moments, never overlapping, always finishing at least 5 s before
  chat ends. A 60 s chat gets at most one. Clients can't see what is coming.
- The host pings `POST /api/rooms/[id]/pulse` about every 5 s during CHAT. The server starts or ends events by writing metadata with a
  compare-and-set on `seq`, so a pulse can never overwrite a phase change. It then sends a `game.event` nudge.
- Chat events (Hot seat, One word, Rapid fire, Unpopular opinion) are answered in the normal group chat. Bot answers come from one LLM call
  per event. Hot-seat askers must actually ask (lines without "?" are dropped), and a bot in the hot seat is forced to answer the latest
  question. One-word mode is enforced in the chat input and in the bot humaniser. Free-form bot replies pause during these events.
- Pick events (Point at someone, Defend someone) use `game.pick`. Bots pick deterministically from affinity. At the end the server
  stores only **aggregate counts** in `state.eventLog`, never identities.
- Cost: at most one extra LLM call per event, and none for pick events.

## D18. Reveal detail lives in the message, not the metadata

CometChat caps group metadata at **5 KB** (MCP: `/articles/properties-and-constraints`) and message `data` at 10 KB. The compact
results (counts only) stay in metadata. Personas, objectives, archetypes and defenses ride in the `game.reveal` custom message, which
is sent only at REVEAL. Clients also restore it from history after a reconnect. `saveState` trims `eventLog` if the state ever nears the cap.

## D19. Awards only when the data supports them

Most convincing bot, Most bot-like human, Most trusted (≥ 1 pick), Biggest suspect (BOT votes + trust-least + point picks ≥ 2),
Chaos agent (≥ 2 accusations or pushbacks, counted by keyword), Best defense (was suspected, defended, and the verdicts swung their way:
HUMAN ≥ BOT votes). Each award is omitted when nobody qualifies. All are computed from counts. "Best defense" uses the
vote swing because no separate reaction mechanic exists. Inventing a reaction count would be fabrication.

---

# Multiplayer-first transformation (round 3)

## Audit (before changes)

**Keep as-is (works, tested live):** CometChat identity (server-minted auth tokens), private group per room, server-written metadata
state plus `game.*` nudges, the pure state machine, host election with server-enforced timers, commit/reveal of the bot roster, the bot
planner/humanizer/moderation, trust, final defense, interrogation events, the reveal and the 3D room.

**Gaps that break multiplayer (fixed below):**

1. *Bots trickled into the lobby* while friends were still joining, so seats filled before invitees arrived.
2. *Seat order leaked the composition.* The roster was humans first, then bots added at start.
3. *Names leaked the composition.* Friends know each other's names. With real names at the table, four friends instantly know the other
   two are bots, and the game is over before it starts.
4. *Private decisions were public.* `game.vote`, `game.trust` and `game.pick` carried ballots in plaintext to every client, and the
   server let bots read human trust picks (unfair knowledge).
5. Lobby chat (with real names) stayed visible during the round, which would undo any anonymity.

## D20. Seats fill at start, not before

No more lobby trickle. The lobby shows six seats and only the people who joined. When the host starts, empty seats fill with bots and
the **whole roster is shuffled** (crypto RNG), so seat order says nothing. One human means solo/practice automatically. Same engine, same
phases, no separate mode. Landing offers "Play with friends" (shareable room) and "Play solo" (same room flow, auto-starts).

## D21. Round aliases: everybody is a stranger at the table

At round start every seat, human or bot, gets a fresh alias from a pool of believable handles (`state.aliases`, uid → alias). It is
public, because aliases are random and carry no signal. During the round the UI shows **only aliases**: seats, chat, typing, events, votes,
name tags, and the bots' own prompts (a bot "shows as" its alias). The chat view hides messages from before the round, so lobby talk
can't map aliases back to people. Each human sees "You are KAVYA tonight". Friends genuinely don't know which alias is their friend, which
is what makes bluffing, false accusations and "I'm literally a bot" possible. It also fixes the repeat-player tell ("riya is always a bot"),
because persona names no longer appear in the UI. At reveal each alias is unmasked: humans show their real name, bots show their
persona.

Rejected: renaming CometChat users per round. Pooled bots can sit in several rooms at once, so a rename in one room would leak into
another.

## D22. Sealed ballots over CometChat

Votes, trust picks and event picks are still CometChat custom messages (the sender proves who voted, and "4/6 filed" still works), but
their contents are **sealed**: ECDH P-256 plus AES-GCM to a server key derived from `SESSION_SECRET`. The browser encrypts with WebCrypto,
and the server opens them only when tallying. Other players, and their devtools, see *that* you voted, never *what*. Bot ballots are sealed
the same way, so the envelopes are indistinguishable.

## D23. Bots know only what a player could know

Bots decide from the public conversation, public aggregates (event results), their own persona and their own objective. The server no
longer feeds them other players' trust picks or ballots. They never see other bots' identities or objectives: the prompt describes only
the bots being voiced, and calls every other seat by its alias.

## D24. Bots remember and adapt (deterministically, no extra LLM calls)

Each planning call carries a compact **memory** extracted with plain rules from the whole round:

- self-disclosures ("I'm from Jaipur", "I hate gyms"),
- accusations and vouches (who called whom a bot, who said whom is human),
- event outcomes.

It goes inside the existing single prompt (capped at about 8 notes). Bots that are being ignored get more airtime, bots that are addressed or
accused always get a chance to answer, and a quiet room still triggers the idle opener. Game rules (who may speak, budgets, timing,
objectives, scoring) stay outside the LLM.

### Remaining side channels (documented, not hidden)

A determined player can still notice transport-level details: CometChat member join times (humans joined in the lobby, bots at start),
sender `status` fields, and that bot messages are sent via REST. None of these is shown or used by the UI. Closing them fully would need bots
to hold real WebSocket sessions, which needs a long-running server and is out of scope for Vercel Hobby.

## Verification (round 3)

`npm run sim -- N` for N = 1..6 passes against the live CometChat app. Three simultaneous browser sessions (alias intro, aliased chat, bots
reacting to a human's "I'm literally a bot" and accusation, hot seat and unpopular opinion events, trust, vote, reveal with social
consequences and a round recap) were also driven by hand. Fixed along the way: `overrated` counted as pushback in the objective heuristic, and a
hot seat could stall if the model returned no question (now falls back to a plain one).

---

# Anonymous identity (round 4)

## D25. Real names never reach the wire

The user enters a real name **once** (first visit, or the invite page). It is kept in the browser's own session and shown back only
to that user. On CometChat **every account, human or bot, is named "Player"**. The real name is stored only as AES-256-GCM ciphertext in the
user's metadata (`sn`, key derived from `SESSION_SECRET`). Bots carry a decoy sealed name too, so the presence of metadata is not a tell.
Member lists, message sender entities, typing and presence payloads therefore never contain a real name. The server opens sealed names
only when building the reveal, which is published in the `game.reveal` message. The UI never displays a CometChat display name.

Lobby: anonymous slots ("You" / "Anonymous player"), "Identities are sealed when the case begins." Invite: "You've been invited to a NOT A BOT
case." plus the link. Neither the URL nor the text names the inviter.

## D26. Always at least one AI

Max 5 humans per case (`MAX_HUMANS`). `composeTable` seats at most 5 humans and fills to 6 with bots. Join re-checks the cap after
adding (concurrent joins overshot it in testing): late arrivals beyond the fifth human step back out with "This case is full."

## D27. Two-layer reveal and composition-aware recap

Each spotlight answers "human or bot?" and then "who was it really?" ("Actually: Ansh" / "AI persona: Maya"). The closing screen shows the
roster unsealed. `lib/game/recap.ts` (salvaged from an abandoned Quick Match attempt) adapts to the real composition: one human gives a
**Solo case** recap ("You were the only human", "Bots correctly identified 3 / 5"), with no human-vs-human stats.

Quick Match / separate modes: an unfinished Quick Match implementation was found in the tree. It contradicts the one-case rule and did not
compile. It was moved out of the project (to the session scratchpad), not merged.

## D28. Events that create evidence

New interrogation events: **Everyone answers** (same question, comparable answers), **Cross-examination** (examiner → target),
**Contradiction detected** and **Memory check**. Contradiction and memory are mined **deterministically** (`lib/game/evidence.ts`). A
contradiction is only claimed for the same player saying "I love X" and "I hate X" about the same subject. A memory cue is a word exactly one
player used. If no real evidence exists, the slot falls back to "Everyone answers", so nothing is invented. Hot seat now asks a concrete
question. Every round has at least one event; evidence events only take the later slot; events are pulled earlier to fit short rounds.

## D29. Faster chat

Short bot reactions think 0.4–1.5 s; longer ones up to about 3.5 s. Typing runs at about 1.6× persona speed, capped at 6 s. The prompt pushes
reaction-sized messages ("nah 😭", "bro what").

## D30. 3D that plays along

Busts breathe, turn their heads toward whoever just spoke and dip while typing. A floor ring marks whoever is on the spot (or the room's last
"point at" result). The camera tightens during the defense, widens for verdicts, leans toward the player on the spot and drifts toward speakers.
All of it is per-frame inside `useFrame`, with no React state. The HUD lists players by case name only.

## D31. Free-plan user quota

CometChat's free plan caps an app at **100 users total** (`ERR_PLAN_QUOTA_RESTRICTION`, hit during testing). Players keep their uid
across visits, bots are a fixed pool of 12, `npm run sim` now reuses cached identities, and `npm run cleanup:test-users` (dry run by
default) removes users created by test scripts.

## D32. Solo cases that feel like six different people

Problem: with one human, five bots felt like five copies of one model. Fixes (no second bot engine; all in the existing planner/runtime):

- **Per-case temperament** (`lib/bots/temperament.ts`): every bot rolls fresh dials each round from the round's secret seed: talk, initiative,
  aggression, sociability, confidence, suspicion, contrarian streak, loyalty, speed, verbosity. Skewed draws spread the five apart. The persona
  still supplies the *voice* (style, Hinglish, opinions); the temperament drives *behaviour*, so the same voice plays differently in each case,
  and aliases are re-rolled, so no name is tied to a personality.
- **Private social state per bot**: `socialView` gives each bot its own trust and suspicion of every player, from the conversation weighted by
  its temperament plus a stable private hunch per (bot, target). Trust picks, event picks and **votes** come from that bot's own view
  (`trustFromView`, `ballotsFromView`), so bots reach different conclusions and don't converge on one player. The view, stance and hunches
  go into that bot's private prompt only. Nothing reaches clients.
- **Group chat, not a queue**: replies are scheduled independently (temperament speed, message length, chance), sorted, with only a small
  minimum gap. Bots can answer, back up, question or accuse each other: the prompt says so explicitly, and up to 3 bot lines may run between
  human messages. Quiet rooms are restarted by a bot engaging *another player*. Reply count per tick varies 1–3; some bots simply don't answer.
- **No repetition**: each bot sees its own last lines; near-duplicates (word overlap ≥ 70%) are dropped server-side; a bot can't take two turns
  in a row unless addressed; self-addressing lines are dropped; long lines are trimmed at clause boundaries instead of mid-sentence.
- **3D**: idle breathing, head sway and typing nods vary per seat, keyed by the round alias (identical rule for humans and bots, so no tell).

Verified with live solo cases (`SIM_TRANSCRIPT=1 npm run sim -- 1`): bots accused the human, defended each other, called each other out
("Vik why are you calling everyone a bot now") and picked different sides. Two-human cases still pass.

## D33 — Player-account limit is surfaced, never hidden

**Problem.** The free CometChat plan caps the app at 100 users. Test runs and the abandoned Quick Match work had used all 100 (77 test accounts). New invitees failed at `POST /api/session` with a 402 before they reached the room. The host saw an empty lobby and started a "solo" case.
**Decision.** `ERR_PLAN_QUOTA_RESTRICTION` now maps to a 503 `player_limit` response with a clear message. `/api/session` takes the optional `roomId` and writes `lobbyNotice` into the lobby state, so the host sees "Someone couldn't get in". The host polls the lobby every 5 s. Returning players reuse their uid and need no new account. Bots are seated only at start. Clean up with `npm run cleanup:test-users` (a dry run; `-- --yes` deletes test-named accounts only and never touches real players, hosts or the bot pool).

## D34: Chat never depends on the realtime socket alone

**Problem.** In production the CometChat socket sometimes did not deliver bot messages. Players never saw the bots, and the host (which
triggers bot replies on new messages) went silent too. Separately, the host detected new messages by list length, which stops growing
once the 200-message cap is reached.
**Decision.** Every client polls the latest 30 text messages every 3 s outside the lobby; the reducer de-duplicates by message id.
The host now tracks the newest message key instead of the count.
