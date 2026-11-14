# Watch Together Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Friends in different houses watch the same movie/episode in sync from Mediarr: invite accounts (with a popup + 🔔 menu) or send a guest link; anyone can play/pause/seek; parties follow a show episode by episode.

**Architecture:** An in-memory party store on the server holds the authoritative playback state; each viewer keeps a websocket to it for commands, state pushes and clock pings. Each viewer streams with their own existing playback session (copy/convert as today, party viewers exempt from the conversion limit). Guests are a separate principal carried by an httpOnly cookie that unlocks only the party's current title. The web player gets a "party mode" that sends user actions to the party and applies pushed state with clock-offset scheduling and drift correction.

**Tech Stack:** Fastify 5 + `@fastify/websocket` (v11, the Fastify 5 line), `node:sqlite`, React 18 + React Query, hls.js light, vitest.

**Spec:** `docs/superpowers/specs/2026-11-13-watch-together-design.md`

## Global Constraints
- Everything under `/api` not listed in `USER_ALLOWED` (server/src/auth/security.ts) is admin-only; every new user-facing route must be added there deliberately.
- State-changing requests need header `x-requested-with: mediarr` and a same-host Origin; the websocket upgrade must check the Origin host equals the Host too.
- Guest token ≥ 128 bits of randomness, stored only as a SHA-256 hash; guest access ends when the party ends.
- Guests reach nothing but: the party socket, and `info`, `start`, `hls`, `subtitle`, `fonts`, `fonts/:name`, `trickplay/:sheet`, `extras` for the party's **current** title. No progress saving, no library, no other titles.
- Party viewers skip `maxTranscodes`.
- Guest invites are impossible for adult (`media.adult = 1`) titles; accounts without `allow_adult` can't join parties for adult titles nor appear in their invite list.
- Party ends after 10 minutes with nobody connected, or when the host presses End party. Websocket keep-alive ping every 30 s.
- Drift thresholds: |drift| < 0.1 s ignore; 0.1–1 s playbackRate 0.95/1.05 until within 0.05 s; > 1 s jump. Buffering reported after 300 ms of `waiting`; a viewer still buffering after 20 s is skipped. Play is scheduled ≈ max viewer latency ahead, capped at 300 ms.
- Copy is plain and friendly, matching the app ("Waiting for alex…", "jacob invited you to watch Intro Test · S01E01").
- Never test against the user's real instance; manual checks on the test copy (port 7990, scratch data14).
- **No commits per task:** the user commits and releases only after saying "Yes, release it". Work stays uncommitted in the tree until then; never commit `data/`.

## Review Focus
1. **Host reloads / connection blips:** a party with members briefly at 0 connected must survive (10-minute grace) and the reconnecting viewer must resync to the current position, not restart at 0. → Task 1 test `survives everyone dropping briefly`, Task 4 test `reconnect gets current state`.
2. **Echo loops:** a pushed pause/seek applied by the player must not be re-sent as a user command (two clients ping-ponging). → Task 6 step "programmatic changes are flagged" + Task 5 test `isEcho`.
3. **Guest cookie on a different party / after the party ends:** must 401/404 everything, including HLS pieces of a session it created earlier. → Task 3 tests `guest token for ended party is refused`, `guest can't open another title`.
4. **Episode advance while someone is mid-buffer or a guest's stream is converting:** everyone moves; stale buffering flags must be cleared for the new episode. → Task 1 test `advance clears buffering and resets position`.
5. **Two tabs of the same account in one party:** the second tab ends the first tab's stream (one stream per account). Expected: the newer tab wins, the older shows "This party is open in another tab". → Task 4 test `second socket for same principal replaces the first`.

---

### Task 1: Party state core (pure, no I/O)

**Files:**
- Create: `server/src/party/state.ts`
- Test: `server/src/party/state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Title = { kind: 'movie' | 'episode'; id: number };
  export type Principal = { type: 'user'; userId: number; name: string } | { type: 'guest'; guestId: number; name: string };
  export const principalKey = (p: Principal) => string; // 'u:12' | 'g:3'
  /** Playback session owner id: users their id, guests -guestId (never collides). */
  export const viewerId = (p: Principal) => number;
  export interface PlayState { playing: boolean; position: number; at: number /* server ms */; version: number }
  export interface Party { id: string; hostUserId: number; mediaId: number; title: Title; state: PlayState;
    members: Map<string, { principal: Principal; connected: number /* socket count */; buffering: number | null /* since ms */ }>;
    guestTokenHash: string | null; nextGuestNumber: number; emptySince: number | null; ended: boolean; createdAt: number;
    /** Paused only because someone buffered: resume once everyone is ready. */ resumeAfterBuffer: boolean }
  export function newParty(id: string, host: Principal & { type: 'user' }, mediaId: number, title: Title, position: number, now: number): Party;
  export function positionAt(s: PlayState, now: number): number;
  export function applyCommand(p: Party, c: { type: 'play' } | { type: 'pause' } | { type: 'seek'; position: number }, now: number, leadMs: number): PlayState;
  export function setBuffering(p: Party, key: string, buffering: boolean, now: number, leadMs: number): PlayState | null; // returns new state when it changed play/pause
  export function tickBuffering(p: Party, now: number, leadMs: number): PlayState | null; // skips >20 s
  export function connect(p: Party, principal: Principal, now: number): void;
  export function disconnect(p: Party, key: string, now: number): void;
  export function shouldEnd(p: Party, now: number): boolean; // ended flag or emptySince + 10 min
  export function advance(p: Party, mediaId: number, title: Title, now: number): PlayState; // next episode, position 0, playing
  export const SKIP_BUFFERING_MS = 20_000, EMPTY_END_MS = 600_000, MAX_LEAD_MS = 300;
  ```
- Rules: `play` sets `at = now + min(leadMs, MAX_LEAD_MS)` and `position = positionAt(old, now)`; `pause` freezes `position = positionAt(old, now)`, `at = now`; `seek` keeps `playing`, sets position, `at = playing ? now + lead : now`. Every change bumps `version`. While any connected member is buffering the party is paused with `waitingFor` derivable from members; resuming happens only if the party was playing before the buffer pause (track `resumeAfterBuffer: boolean` on Party).

- [ ] **Step 1: Write the failing tests** — in `state.test.ts`:
  - `play schedules a common start`: `applyCommand(p,{type:'play'},1000,200)` → `{playing:true, at:1200}`; `positionAt(state, 2200)` = start position + 1.
  - `pause freezes the position`: after play at position 10, pause at now = at+5000 → position 15, playing false.
  - `seek while playing stays playing`; `version increments on each command`.
  - `buffering pauses everyone and resumes when all are ready`: two members; setBuffering(a,true) → paused; setBuffering(a,false) → playing with at = now + lead.
  - `buffering while paused does not resume on ready`.
  - `a viewer stuck buffering is skipped after 20 s`: tickBuffering at +20_001 → playing, member's buffering cleared.
  - `survives everyone dropping briefly`: disconnect all at t, `shouldEnd(p, t + 599_999)` false, connect again, `shouldEnd(p, t + 700_000)` false; disconnect at t2, `shouldEnd(p, t2 + 600_001)` true.
  - `advance clears buffering and resets position`: buffering member, advance → title changed, position 0, playing, no member buffering.
  - `viewerId never collides`: user 3 → 3, guest 3 → -3.
- [ ] **Step 2:** Run `npx vitest run src/party/state.test.ts` (in `server/`) → FAIL (module missing).
- [ ] **Step 3:** Implement `server/src/party/state.ts` with the interface above.
- [ ] **Step 4:** Run the same command → PASS.
- [ ] **Step 5:** Checkpoint: whole server suite (`npm test`) green. No commit (see Global Constraints).

---

### Task 2: Notifications and the invite list

**Files:**
- Modify: `server/src/db.ts` (SCHEMA: new table + index)
- Create: `server/src/core/notifications.ts`, `server/src/routes/notifications.ts`
- Modify: `server/src/app.ts` (register), `server/src/auth/security.ts` (`USER_ALLOWED`)
- Test: `server/src/routes/notifications.test.ts`

**Interfaces:**
- Table: `notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT)`, index `idx_notifications_user ON notifications(user_id, id)`.
- Produces (`core/notifications.ts`):
  ```ts
  export interface PartyInvitePayload { partyId: string; from: string; title: string; subtitle: string | null; poster: string | null }
  export function notify(userId: number, kind: 'party_invite', payload: PartyInvitePayload): number;
  export function listNotifications(userId: number, limit = 50): { id: number; kind: string; payload: PartyInvitePayload; createdAt: string; read: boolean }[];
  export function unreadCount(userId: number): number;
  export function markRead(userId: number, ids: number[] | 'all'): void;
  export function dismiss(userId: number, id: number): void;
  ```
- Routes (all in `USER_ALLOWED`): `GET /api/notifications` → `{ unread, items }` where each party invite item also carries `active: boolean` (looked up via an injected `isPartyActive(id)`; Task 3 supplies it — until then default `() => false`); `POST /api/notifications/read` body `{ ids: number[] | 'all' }`; `DELETE /api/notifications/:id`.
- `GET /api/party/invitees?mediaId=` → `{ id, username }[]` of other accounts allowed to see that title (exclude self; exclude non-`allow_adult` users when the title is adult). Lives in this task's route file, also in `USER_ALLOWED`.

- [ ] **Step 1: Write failing tests** (`notifications.test.ts`, using `buildApp` + two users like other route tests):
  - `a user sees only their own notifications` (user B's list empty after notifying A).
  - `unread count drops after marking read`; `dismiss removes it`; `can't dismiss someone else's` (404 or no-op, A's item stays).
  - `invitees exclude yourself and, for an 18+ title, accounts without NSFW access`.
  - `a regular user can call these; signed out gets 401`.
- [ ] **Step 2:** Run `npx vitest run src/routes/notifications.test.ts` → FAIL.
- [ ] **Step 3:** Implement table, core module, routes; register in `app.ts`; add the four route keys to `USER_ALLOWED`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Checkpoint: whole server suite (`npm test`) green. No commit (see Global Constraints).

---

### Task 3: Party REST routes and the guest principal

**Files:**
- Create: `server/src/party/store.ts` (in-memory registry + sweeper), `server/src/party/routes.ts`, `server/src/party/guest.ts`
- Modify: `server/src/auth/security.ts` (guest principal in the onRequest hook), `server/src/routes/play.ts` (viewer id, guest title check, no progress for guests, party exemption passed to `createSession`), `server/src/playback/sessions.ts` (`NewSession.exempt?: boolean`, skips the `maxTranscodes` checks in `createSession` and `waitForSegment` when set — store it on `Session`), `server/src/app.ts`
- Test: `server/src/party/routes.test.ts`

**Interfaces:**
- Consumes: Task 1 state functions; Task 2 `notify`, `isPartyActive` hook-up.
- Produces (`store.ts`): `createParty(host, mediaId, title, position): Party`, `getParty(id): Party | null` (null when ended), `endParty(id): void` (marks ended, ends every member's playback session via `endUserSessions(viewerId)`, notifies sockets via a listener `onPartyEnded(cb)`), `partyForGuestToken(token): { party, guestId } | null`, `isPartyActive(id): boolean`, `sweepParties(now)` on a 30 s unref'd interval (ends parties where `shouldEnd`).
- Guest principal: `declare module 'fastify' { interface FastifyRequest { guest: { partyId: string; guestId: number; name: string } | null } }`. Cookie `mediarr_guest` = `<partyId>.<guestId>.<secret>`, httpOnly, SameSite=Lax, Path=/, Secure when HTTPS. Secret per guest (32 random bytes, base64url), only its SHA-256 kept on the member.
- In the security hook, **only when there is no signed-in user**: parse the guest cookie; if valid for a live party, set `req.guest` and allow exactly these keys (`GUEST_ALLOWED`): `GET /api/play/:kind/:id/info`, `POST /api/play/:kind/:id/start`, `GET /api/play/hls/:session/:file`, `DELETE /api/play/hls/:session`, `GET /api/play/:kind/:id/subtitle/:track`, `GET /api/play/:kind/:id/fonts`, `GET /api/play/:kind/:id/fonts/:name`, `GET /api/play/:kind/:id/trickplay/:sheet`, `GET /api/play/:kind/:id/extras`, `GET /api/party/:id`, `GET /api/party/:id/socket`, `POST /api/party/:id/leave`. Anything else → 401 as today.
- In `play.ts`: `const viewer = (req) => req.user?.id ?? -req.guest!.guestId`; the existing preHandler additionally rejects a guest whose `:kind/:id` isn't the party's current `title` (404). `info` returns `position: 0` and `next/prev: null` for guests (party drives episodes). `start` passes `exempt: isPartyMember(viewer, title)` — store exposes `isPartyMember(viewerId: number, title: Title): boolean`.
- REST (`routes.ts`):
  - `POST /api/party` body `{ kind, id, position }` → `{ id, url: '/party/<id>' }` (any account; must be allowed to see the title).
  - `GET /api/party/:id` → `{ id, title: Title, mediaId, titleLabel, subtitle, poster, hostUserId, isHost, guestInviteAllowed, members: { key, name, connected, buffering }[], state, ended }` for members/invitees/guests of that party.
  - `POST /api/party/:id/invite` body `{ userIds: number[] }` → creates `party_invite` notifications (skips users not allowed to see the title) → `{ invited: number[] }`.
  - `POST /api/party/:id/guest-link` → `{ url: '/party/<id>/guest#<code>' }` where `<code>` is a party-level guest invite code (≥128 bits, hash stored as `guestTokenHash`); 403 for adult titles.
  - `POST /api/party/:id/guest-join` body `{ code, name? }` (public route, in `PUBLIC_API`) → validates code, creates a guest member ("Guest 2"… when no name, name trimmed to 24 chars), sets the cookie → `{ ok: true }`. Rate-limited like login (`auth/rateLimit.ts`).
  - `POST /api/party/:id/end` (host only) → ends it. `POST /api/party/:id/leave` → removes the caller from members and ends their playback session.
  - All party routes except guest-join added to `USER_ALLOWED`.

- [ ] **Step 1: Write failing tests** (`routes.test.ts`, `buildApp` with a stub ffmpeg-free path where needed):
  - `any account can start a party and invite another; the invitee gets a notification marked active`.
  - `a guest link joins as "Guest 2" and the cookie opens only that title's info` (info for the party title 200; another episode 404; `/api/media` 401).
  - `guest token for ended party is refused` (after `POST /end`, the guest's `GET /api/party/:id` → 401).
  - `guest can't open another title` and `can't save progress` (`PUT /api/play/episode/:id/progress` → 401).
  - `no guest link for an 18+ title` (403); `an account without NSFW access can't join an 18+ party` (403/404).
  - `only the host can end the party` (other member → 403).
  - `party viewers skip the conversion limit` (unit test in `sessions.test.ts`: with `maxTranscodes: 1` and one conversion running, `createSession({... exempt: true})` succeeds; without `exempt` it throws 503).
- [ ] **Step 2:** Run `npx vitest run src/party src/playback/sessions.test.ts` → FAIL.
- [ ] **Step 3:** Implement store, guest cookie handling, routes, security hook branch, play.ts changes, sessions `exempt`.
- [ ] **Step 4:** Run → PASS, then `npx vitest run` (whole server) → PASS (existing auth allowlist test still green).
- [ ] **Step 5:** Checkpoint: whole server suite (`npm test`) green. No commit (see Global Constraints).

---

### Task 4: The sync channel (websocket)

**Files:**
- Modify: `server/package.json` (add `@fastify/websocket` ^11), `server/src/app.ts` (register plugin before party routes)
- Create: `server/src/party/socket.ts`
- Test: `server/src/party/socket.test.ts`

**Interfaces:**
- Consumes: Task 1 state, Task 3 store and principal on `req`.
- Route `GET /api/party/:id/socket` (`{ websocket: true }`). On upgrade: reject when Origin host ≠ Host, when the caller isn't a member/allowed account (accounts allowed to see the title join automatically as members), or when the party ended.
- Messages (JSON). Client → server: `{ t: 'ping', c: clientMs }`, `{ t: 'play' }`, `{ t: 'pause' }`, `{ t: 'seek', p: seconds }`, `{ t: 'buffering', on: boolean }`, `{ t: 'next' }`, `{ t: 'rtt', ms }` (client's latest round trip, used for the play lead). Server → client: `{ t: 'pong', c, s: serverMs }`, `{ t: 'state', state: PlayState, title: Title, members: { key, name, connected, buffering }[], waitingFor: string[] }`, `{ t: 'ended' }`, `{ t: 'replaced' }` (another socket of the same principal took over).
- Lead for scheduled play = max of members' last reported RTT/2, capped at `MAX_LEAD_MS`.
- `next`: server resolves the next playable episode (reuse `playableEpisodes` from `core/home.ts`), calls `advance`, broadcasts state with the new title; no-op for movies or the last episode.
- Rate limit: drop more than 20 command messages per second per socket.
- Server pings every 30 s (ws ping frames) and runs `tickBuffering` every 1 s for parties with buffering members.

- [ ] **Step 1: Write failing tests** (`socket.test.ts`; `buildApp` + `app.listen({ port: 0 })` + `ws` client from the plugin's dependency, or `app.injectWS` from `@fastify/websocket`):
  - `two members get the same state when one pauses` (A sends pause → both receive `state` with playing false and equal version).
  - `pong carries server time`.
  - `reconnect gets current state` (A disconnects, reconnects → first message is `state` with position ≈ positionAt).
  - `second socket for same principal replaces the first` (first receives `replaced` and closes).
  - `next moves everyone to the next episode` (title id changes in both clients' state).
  - `ending the party closes sockets with ended` and `a cross-site Origin is refused`.
- [ ] **Step 2:** Run `npx vitest run src/party/socket.test.ts` → FAIL.
- [ ] **Step 3:** `npm install @fastify/websocket@^11 -w server`; implement `socket.ts`; register.
- [ ] **Step 4:** Run → PASS; whole server suite → PASS.
- [ ] **Step 5:** Checkpoint: whole server suite (`npm test`) green. No commit (see Global Constraints).

---

### Task 5: Client sync math

**Files:**
- Create: `web/src/party/sync.ts`, `web/src/party/sync.test.ts`
- Modify: `web/package.json` (`"test": "vitest run"`, devDependency `vitest` at the server's version), root `package.json` (`"test": "npm test -w server && npm test -w web"`)

**Interfaces:**
- Produces:
  ```ts
  export class Clock { sample(clientSent: number, serverTime: number, clientReceived: number): void; offset(): number /* serverMs - clientMs, from the lowest-RTT of the last 5 samples */; rtt(): number; now(): number /* Date.now() + offset */ }
  export type Correction = { kind: 'none' } | { kind: 'rate'; rate: 0.95 | 1.05 } | { kind: 'reset-rate' } | { kind: 'jump'; to: number };
  export function expectedPosition(state: { playing: boolean; position: number; at: number }, serverNow: number): number;
  export function correction(currentTime: number, expected: number, currentRate: number): Correction;
  export function isEcho(lastApplied: { type: 'play' | 'pause' | 'seek'; position: number; atClient: number } | null, event: { type: 'play' | 'pause' | 'seek'; position: number; atClient: number }): boolean; // within 400 ms and 0.25 s of what we just applied
  ```
- [ ] **Step 1: Write failing tests:** offset picks the lowest-RTT sample; `expectedPosition` before `at` returns `position` (scheduled start not reached); correction cases: drift 0.05 → none; 0.3 ahead → rate 0.95; 0.3 behind → rate 1.05; back within 0.05 at rate ≠1 → reset-rate; 1.5 → jump to expected; `isEcho` true for the pause we just applied 100 ms ago, false 1 s later or for a different position.
- [ ] **Step 2:** `npm test -w web` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test -w web` → PASS; `npm test` at root runs both.
- [ ] **Step 5:** Checkpoint: whole server suite (`npm test`) green. No commit (see Global Constraints).

---

### Task 6: Party mode in the player (accounts and guests)

**Files:**
- Create: `web/src/party/useParty.ts`, `web/src/pages/Party.tsx`
- Modify: `web/src/pages/Watch.tsx`, `web/src/App.tsx`, `web/src/main.tsx` (guest routes bypass `AuthGate`), `web/src/api.ts` (party types), `web/src/styles.css`

**Interfaces:**
- Consumes: Task 3 REST, Task 4 messages, Task 5 `Clock`, `correction`, `isEcho`, `expectedPosition`.
- `useParty(partyId: string): { party: PartyInfo | null; state: PlayState | null; title: Title | null; members; waitingFor: string[]; send(cmd): void; status: 'connecting' | 'live' | 'ended' | 'replaced' | 'error'; clock: Clock }` — opens `ws(s)://<host>/api/party/<id>/socket`, reconnects with backoff (0.5, 1, 2, 4 s, max 10 s), pings every 5 s for the first 30 s then every 30 s.
- `Player` gains an optional prop `party?: PartyBinding` where `PartyBinding = { send, state, title, members, waitingFor, clock, guest: boolean, isHost: boolean, onLeave(), onEnd() }`. When present:
  - `togglePlay` / `seek(byUser=true)` send `play`/`pause`/`seek` instead of acting locally; pushed state is applied programmatically, recorded as `lastApplied` so the resulting media events are recognised by `isEcho` and not re-sent. **Programmatic changes are flagged** — no pushed change may call `send`.
  - A 500 ms interval applies `correction` (sets `playbackRate` / `currentTime`).
  - `waiting` > 300 ms not within 1 s of a seek we applied → `send({t:'buffering', on:true})`; `canplay` with ≥ 2 s buffered ahead → `on:false`.
  - The resume prompt is skipped (start at the party position); the stream starts at `expectedPosition(...)`.
  - Next episode (button, countdown, Shift+N, end-of-video) sends `{ t: 'next' }`; when pushed state's `title` differs from the player's, the page navigates to the new title within party mode (Party page re-keys the Player).
  - Top bar shows "👥 N watching" (hover/tap lists names); overlay "Waiting for alex…" while `waitingFor` is non-empty; a ⋯ menu entry "Leave party" for all, "End party for everyone" for the host.
  - Guests (`guest: true`): no back button, no prev/next buttons, no progress saving, no links out.
- Routes: `/party/:id` → `Party.tsx` (signed-in members: loads `GET /api/party/:id`, then `Watch`-style info fetch for `party.title`, renders `Player` with `party`). `/party/:id/guest` → join screen (name box with placeholder "Guest", Join button → `POST guest-join` with the `#code` from the URL, then the bare player). Both routes render outside the sidebar shell; `/party/:id/guest` also outside `AuthGate`. Ended party → "This watch party has ended." (guests: nothing else on the page).

- [ ] **Step 1:** Implement `useParty` and `Party.tsx`; wire routes in `App.tsx`/`main.tsx`.
- [ ] **Step 2:** Add the `party` prop paths in `Watch.tsx` as listed; **programmatic changes are flagged** via a `lastApplied` ref checked with `isEcho` in `onPlay`/`onPause`/`onSeeked` before sending.
- [ ] **Step 3:** `npx tsc --noEmit -p web` → no errors; `npm run build` → succeeds.
- [ ] **Step 4:** Checkpoint: whole server suite (`npm test`) green. No commit (see Global Constraints).

(Behaviour is verified end to end in Task 8; the logic it leans on is unit-tested in Tasks 1, 4 and 5.)

---

### Task 7: Invite panel, invite popup and the 🔔 menu

**Files:**
- Create: `web/src/components/InvitePanel.tsx`, `web/src/components/NotificationBell.tsx`, `web/src/components/InvitePopup.tsx`
- Modify: `web/src/pages/Watch.tsx` (👥 Invite button in the top bar, for accounts only), `web/src/App.tsx` (bell next to the account at the bottom of the sidebar; inside the ☰ menu on phones; popup mounted in `Shell`), `web/src/styles.css`

**Interfaces:**
- Consumes: `GET /api/party/invitees`, `POST /api/party` (created lazily the first time Invite is used from a normal player, which then switches into party mode via `navigate('/party/<id>', { replace: true })` keeping the position), `POST /api/party/:id/invite`, `POST /api/party/:id/guest-link`, `GET /api/notifications`, `POST /api/notifications/read`, `DELETE /api/notifications/:id`.
- InvitePanel: title "Invite to watch", search box "Search users…", rows `username` + Invite → "✓ Invited"; divider; "🔗 Guest invite" + Copy (copies the absolute URL; shows "Copied"); hidden when `guestInviteAllowed` is false.
- Bell: query `['notifications']` polled every 5 s (stops in background tabs, React Query default); badge = unread; menu lists invites "jacob invited you to watch Intro Test · S01E01" with Join (active) or "Ended"; opening the menu marks all read; × dismisses.
- InvitePopup: when a new unread `party_invite` with `active: true` appears that wasn't seen before (track seen ids in a ref; don't pop for items present at first load older than 2 minutes), show the card "🎬 jacob invited you to watch / Intro Test · S01E01 / [Dismiss] [Join]" bottom-right for up to 30 s; Join → `navigate('/party/<id>')` and mark read; Dismiss → mark read.

- [ ] **Step 1:** Implement the three components and mount them.
- [ ] **Step 2:** `npx tsc --noEmit -p web` and `npm run build` → succeed.
- [ ] **Step 3:** Checkpoint: whole server suite (`npm test`) green. No commit (see Global Constraints).

---

### Task 8: End-to-end check on the test copy and release prep

**Files:** none new (fixes go to the files of the task they belong to).

- [ ] **Step 1:** `npm run build && npm test` at the repo root → all pass.
- [ ] **Step 2:** Start the test copy (port 7990, data14). Create a second test account if `tester` lacks access; record any new test credentials only in the scratch credentials file.
- [ ] **Step 3:** In two browser tabs (boss, tester) and a third private-style tab (guest): boss opens Intro Test S01E01 → Invite → tester; tester sees the popup within ~5 s and the 🔔 badge; Join. Boss makes a guest link; the guest tab joins as "Guest 3".
- [ ] **Step 4:** Measure with `javascript_tool`: after pause/seek/play from each tab, every tab's `currentTime` agrees within 0.15 s within 1 s; simulate buffering (throttle one tab or block its segment request) → others show "Waiting for …" and resume together.
- [ ] **Step 5:** Guest tab: `/api/media`, another episode's info, `/settings` page → all refused/blank. End party as host → guest tab shows "This watch party has ended." and its HLS requests fail.
- [ ] **Step 6:** Next episode from the tester tab → all three tabs move to S01E02 together.
- [ ] **Step 7:** Stop only the port-7990 process. Report results; ask the user before committing the release.
