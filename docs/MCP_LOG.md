# CometChat MCP Log

Every CometChat decision in this project is backed by the **official CometChat Docs MCP server**.
Research date: **2026-10-06**.

## How the MCP was accessed

No CometChat MCP server was pre-configured in the Claude Code session, so the official public
server was located and called directly over MCP Streamable HTTP (JSON-RPC 2.0):

| Item | Value |
| --- | --- |
| Endpoint | `https://mcp.cometchat.com/mcp` |
| Server info | `CometChat Docs` v`0.1.6`, protocol `2025-03-26` |
| Client used | [`scripts/cometchat-mcp.sh`](../scripts/cometchat-mcp.sh) (curl, initialize → initialized → call) |
| Tools exposed | `search_cometchat_docs`, `fetch_cometchat_doc_page`, `get_cometchat_implementation_bundle`, `list_cometchat_bundles` |
| Resources exposed | `cometchat://skills/overview` + one `cometchat://bundles/<name>` per bundle |

Server instructions said: read `cometchat://skills/overview` first, use bundles for recipes,
search for concepts, fetch pages for exact details. That order was followed.

## Bundles listed (`list_cometchat_bundles`)

All 10 bundles report `last_verified: 2026-04-29`.

| Bundle | Relevant | Fetched |
| --- | --- | --- |
| `js-sdk-messaging-basics` | yes, core SDK | yes |
| `presence-and-typing` | yes | yes |
| `moderation-setup` | yes | yes |
| `multi-tenant-chat` | yes (server-issued auth tokens, UID prefixing, REST users/groups) | yes |
| `react-uikit-quickstart` | no: we need a fully custom game UI, not the UI Kit | no |
| `widget-embed`, `react-native-*`, `flutter-*`, `ios-*`, `android-*` | no | no |

Resource `cometchat://skills/overview` (`last_verified: 2026-04-30`) was read in full.

## Pages fetched (`fetch_cometchat_doc_page`)

`/sdk/javascript/setup-sdk`, `/sdk/javascript/authentication-overview`, `/sdk/javascript/send-message`,
`/sdk/javascript/receive-message`, `/sdk/javascript/typing-indicators`, `/sdk/javascript/user-presence`,
`/sdk/javascript/transient-messages`, `/sdk/javascript/connection-status`, `/sdk/javascript/join-group`,
`/sdk/javascript/retrieve-groups`, `/sdk/javascript/flag-message`, `/sdk/javascript/llms-javascript-v4`,
`/rest-api/authentication`, `/rest-api/auth-tokens/create`, `/rest-api/users`, `/rest-api/users/create`,
`/rest-api/groups/create`, `/rest-api/groups/update`, `/rest-api/group-members`,
`/rest-api/group-members/list`, `/rest-api/group-members/add-members`,
`/rest-api/messages/send-message`, `/rest-api/messages/list-group-messages`, `/rest-api/rate-limits`.

Searches (`search_cometchat_docs`) were run for: REST send on behalf of user, REST typing indicator,
transient messages, custom messages in groups, auth token creation, user creation, adding group
members, joining groups, rate limits, reconnect/connection listener, member joined/left listener,
fetching group messages with filters, auth-token login, changelog, group metadata update,
flag/report message, user status listing.

## Version facts

| Item | Value | Source |
| --- | --- | --- |
| JS SDK package | `@cometchat/chat-sdk-javascript` | bundle `js-sdk-messaging-basics`, `/sdk/javascript/setup-sdk` |
| Version installed | `4.2.0` (latest stable on npm, published 2026-09-07; `4.2.1-beta` ignored) | `npm view` |
| Docs version | JavaScript SDK docs are labelled `v4`, `isCurrent: true` | `search_cometchat_docs` result metadata |
| Install | `npm install @cometchat/chat-sdk-javascript` | bundle + setup page |
| REST base URL | `https://{appId}.api-{region}.cometchat.io/v3` | `/rest-api/authentication`, every OpenAPI block |
| Final API check | every SDK call used here was confirmed in `node_modules/@cometchat/chat-sdk-javascript/CometChat.d.ts` | local types |

Contradiction resolved: the overview resource and some bundles show the REST base as `/v3.0` with
`appID` + `apiKey` headers. The REST reference pages (OpenAPI) use `/v3` with a lowercase `apikey`
header and explicitly say "The HTTP header name is `apikey` (lowercase)". We follow the reference
pages: `/v3` + `apikey`. Header names are case-insensitive, so both forms reach the same API.

## Decisions

### 1. Authentication: server-minted Auth Tokens, never the Auth Key in the browser

- **MCP tool:** `get_cometchat_implementation_bundle` (`multi-tenant-chat`), `fetch_cometchat_doc_page`
  (`/rest-api/authentication`, `/rest-api/auth-tokens/create`, `/sdk/javascript/authentication-overview`), overview resource.
- **Verified:** bundles 2026-04-29, overview 2026-04-30.
- **Docs established:** the Auth Key (`authOnly` scope) is for demos only; production must create users with the
  REST API Key (`fullAccess`, server only), mint a token with `POST /users/{uid}/auth_tokens`, and log the client in
  with `CometChat.login(authToken)`. `getLoggedinUser()` returns the persisted session or `null`, so you call `login()` only when needed.
  `POST /users` accepts `withAuthToken: true` to create and mint in one call.
- **Implementation:** `POST /api/session` creates (or reuses) the user with the REST key and returns an auth token.
  `lib/cometchat/client.ts` calls `CometChat.init` → `getLoggedinUser()` → `CometChat.login(authToken)` only when no
  matching session exists. `COMETCHAT_AUTH_KEY` stays server-only and optional. It is never used by the browser.

### 2. SDK init in Next.js (client-only)

- **MCP tool:** `fetch_cometchat_doc_page` (`/sdk/javascript/setup-sdk`, section "SSR Compatibility").
- **Docs established:** the SDK needs `window`/`WebSocket`, so it must load on the client only. `init()` must resolve before any
  other call. Use `AppSettingsBuilder().subscribePresenceForAllUsers().setRegion(region).autoEstablishSocketConnection(true)`.
- **Implementation:** `lib/cometchat/client.ts` loads the SDK with a dynamic `import()` inside client code, memoises `init()`,
  and is only reached from `"use client"` hooks.

### 3. Rooms = private CometChat groups managed by the server

- **MCP tool:** `fetch_cometchat_doc_page` (`/rest-api/groups/create`, `/rest-api/group-members/add-members`, `/rest-api/group-members/list`, `/rest-api/groups/update`).
- **Docs established:** `POST /groups` takes `guid`, `name`, `type` (`public|password|private`) and `metadata`. `POST /groups/{guid}/members`
  adds up to 25 users per call. The resulting action message is sent by `app_system` with `action: added`. `GET /groups/{guid}/members`
  returns `joinedAt`, `status`, `scope`. `PUT /groups/{guid}` updates `metadata`. Groups up to 300 members keep typing indicators and receipts.
- **Implementation:** a room `/r/abc123` is the private group `nab-abc123`. The server adds **both humans and bots** with the same REST call, so
  every seat produces an identical `added by app_system` action. A human cannot be told apart from a bot by how they joined. Humans are participants
  (they cannot edit the group), so only the server can write the game state stored in group metadata.

### 4. Real-time messaging

- **MCP tool:** bundle `js-sdk-messaging-basics`, `fetch_cometchat_doc_page` (`/sdk/javascript/send-message`, `/sdk/javascript/receive-message`).
- **Docs established:** `new CometChat.TextMessage(guid, text, CometChat.RECEIVER_TYPE.GROUP)` + `CometChat.sendMessage`.
  `new CometChat.CustomMessage(guid, RECEIVER_TYPE.GROUP, customType, customData)` + `CometChat.sendCustomMessage`.
  `shouldUpdateConversation(false)` keeps game events out of the conversation preview. Listen with `addMessageListener` (`onTextMessageReceived`, `onCustomMessageReceived`). Fetch history with
  `MessagesRequestBuilder().setGUID().setLimit().setCategories().setTypes().hideReplies().build().fetchPrevious()`. Always remove listeners on unmount.
- **Implementation:** `hooks/useRoom.ts` registers listeners with per-mount IDs and removes them in the effect cleanup. History for late joiners
  is restored via `fetchPrevious()` (texts + `game.*` custom messages).

### 5. Presence

- **MCP tool:** bundle `presence-and-typing`, `fetch_cometchat_doc_page` (`/sdk/javascript/user-presence`).
- **Docs established:** presence is opt-in at init (`subscribePresenceForAllUsers`). `UserListener` has `onUserOnline` / `onUserOffline`. `User.getStatus()` returns `"online" | "offline"`.
- **Implementation:** presence drives host election (earliest-joined member that is online), the "signal lost" seat state, and 3D seat occupancy.

### 6. Typing indicators

- **MCP tool:** bundle `presence-and-typing`, `fetch_cometchat_doc_page` (`/sdk/javascript/typing-indicators`), search "REST API typing indicator".
- **Docs established:** `new CometChat.TypingIndicator(guid, RECEIVER_TYPE.GROUP)` with `startTyping` / `endTyping`, received via
  `onTypingStarted` / `onTypingEnded`. Debounce about 300 ms and end after about 2 s idle. Typing in groups works up to 1000 online users.
  The search found **no REST endpoint for typing indicators**. Typing is an SDK (socket) feature only.
- **Implementation:** humans use the native SDK indicators. Bots never hold a socket, so the server sends a `game.typing` custom message on the bot's
  behalf (`onBehalfOf`). The client folds both into one typing state. The UI renders them the same way.

### 7. Bot messages via REST on behalf of pooled bot users

- **MCP tool:** search "REST API send message on behalf of user onBehalfOf", `fetch_cometchat_doc_page` (`/rest-api/messages/send-message`, `/rest-api/authentication`).
- **Docs established:** `POST /messages` with header `onBehalfOf: <uid>` sends as that user. Body: `receiver`, `receiverType: "group"`,
  `category: "message"`, `type: "text"`, `data.text`, or `category: "custom"`, `type: <customType>`, `data.customData`. Message data max 10 KB.
- **Implementation:** `lib/cometchat/rest.ts#sendGroupMessage` and `sendCustomGroupMessage`. Bot chat lines, bot typing, bot votes and
  server-authored `game.phase` / `game.reveal` events all go through this real CometChat endpoint.

### 8. Bot user pool and MAU

- **MCP tool:** `fetch_cometchat_doc_page` (`/rest-api/users/create`), overview resource.
- **Docs established:** free tier is 100 MAU. Pricing is per MAU. UIDs are alphanumeric with dashes, max 100 chars. A separate "Bot users"
  product exists (max 25). It is not used, because those users would be distinguishable from humans.
- **Implementation:** `scripts/seed-bots.ts` creates a fixed pool of 12 ordinary users. Their UIDs come from an HMAC of the server secret, so they look
  exactly like human UIDs. The script is idempotent (create, or update if the user exists). Humans keep their UID in `localStorage`, so a refresh reuses the same CometChat user.

### 9. Rate limits

- **MCP tool:** `fetch_cometchat_doc_page` (`/rest-api/rate-limits`).
- **Docs established:** the Build (free) plan allows **500 requests/min per app** across core and standard operations, and **30 messages/min per user**.
  A 429 carries `Retry-After`.
- **Implementation:** the server caps bot messages per round, keeps at most 2 bot replies per plan, and debounces ticks to one per room.
  `lib/cometchat/rest.ts` retries a 429 once after `Retry-After` (capped).

### 10. Connection / reconnect

- **MCP tool:** search "connection listener reconnect javascript", `fetch_cometchat_doc_page` (`/sdk/javascript/connection-status`).
- **Docs established:** the SDK auto-reconnects. `ConnectionListener` exposes `onConnected`, `inConnecting`, `onDisconnected`. Do not poll `getConnectionStatus()`.
- **Implementation:** the connection banner ("Reconnecting…") is driven by `ConnectionListener`. On `onConnected` after a drop, the room re-syncs state from group metadata and recent history.

### 11. Moderation

- **MCP tool:** bundle `moderation-setup`, `fetch_cometchat_doc_page` (`/sdk/javascript/flag-message`), search "flag message report".
- **Docs established:** moderation (profanity, image, custom keyword rules, block/mask/flag) is enabled from the dashboard and via `/moderation/rules`.
  `CometChat.flagMessage(messageId, { reasonId, remark })` reports a message, and `getFlagReasons()` lists reasons. Both need moderation enabled in the dashboard.
- **Free-tier fit:** the docs do not promise dashboard moderation on the free Build plan. So the project **does not depend on it**.
- **Implementation:** (a) every bot line passes a server-side filter (`lib/moderation.ts`). Slurs, sexual content and AI self-disclosure drop the line. (b) A Report button calls
  `CometChat.flagMessage`. If that fails because moderation is off, the report falls back to `POST /api/report`, which logs it server-side. The UI never errors.
  (c) If dashboard moderation is enabled, CometChat's own rules apply on top of this.

### 12. Transient messages (considered, not used for state)

- **MCP tool:** `fetch_cometchat_doc_page` (`/sdk/javascript/transient-messages`).
- **Docs established:** `sendTransientMessage` delivers only to online receivers and is never stored. It is SDK-only.
- **Decision:** late joiners must rebuild state, so game events use persisted **custom messages** plus group metadata, not transient messages.

### 13. Metadata size limit (gameplay upgrade)

- **MCP tool:** `search_cometchat_docs` ("group metadata size limit constraint"), `fetch_cometchat_doc_page` (`/articles/properties-and-constraints`).
- **Verified:** 2026-10-06.
- **Docs established:** User/Group metadata is max **5 KB** (inside a 10 KB POST body). A message `data` object is max **10 KB**, and the whole message max 65 KB.
- **Implementation:** the compact game state stays in group metadata (about 0.6 KB in CHAT, about 3 KB at REVEAL). Rich reveal detail (personas, secret
  objectives, defenses) is sent in the `game.reveal` custom message. `saveState` trims the event log if the state approaches 4.6 KB.

### 14. New custom message types (gameplay upgrade)

- **MCP tool:** reused the established custom-message recipe (`/sdk/javascript/send-message` → Custom Message; `/rest-api/messages/send-message` → `category: "custom"`).
- **Implementation:** `game.trust`, `game.defense`, `game.pick` (sent by humans via `CometChat.sendCustomMessage`, by bots via REST `onBehalfOf`)
  and `game.event` (a nudge sent by the server as the host). All have Zod schemas in `lib/game/types.ts`. History restore uses
  `MessagesRequestBuilder.setTypes([...])` (confirmed in the installed `CometChat.d.ts`) to skip `game.typing` noise.

### 15. Multiplayer-first round (sealed ballots, aliases)

- **MCP tools:** reused the established recipes; no new SDK surface. Checked `/sdk/javascript/user-presence` again for host election
  (clients get no presence events about themselves, so a client counts itself online while connected) and `/articles/properties-and-constraints` for metadata limits.
- **Implementation:** `game.vote`, `game.trust` and `game.pick` now carry `{roundId, sealed}` custom data (`CometChat.sendCustomMessage` from humans,
  REST `onBehalfOf` from bots). Aliases live in `state.aliases` (public group metadata, about 0.2 KB). Real names appear only inside the
  `game.reveal` message at REVEAL. Lobby fill was removed (`/api/rooms/[id]/fill` deleted): bots join the CometChat group only when the round starts.
- **Known limit:** CometChat member join times and REST-sent bot messages remain visible at the transport level (see DECISIONS D24).

### 16. Anonymous identity and quota (round 4)

- **MCP tools:** `search_cometchat_docs` ("user metadata private visible to other users"). The docs give no guarantee that user metadata is hidden
  from other clients, so it is treated as public and the real name is stored encrypted. `fetch_cometchat_doc_page` (`/rest-api/users/delete`):
  `DELETE /users/{uid}` with `{ "permanent": true }`, used only by the opt-in cleanup script.
- **Observed live:** `POST /users` returns `402 ERR_PLAN_QUOTA_RESTRICTION` once the free plan's 100-user limit is reached.
- **Implementation:** `POST /api/session` creates or updates users with `name: "Player"` and `metadata.sn` = sealed real name. Bots are reseeded the same way.
