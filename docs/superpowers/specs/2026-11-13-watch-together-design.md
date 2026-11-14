# Watch Together — design

## Intent
Friends in different houses watch the same Mediarr movie or episode at the same moment, each streaming it
themselves (sharp picture), instead of screen-sharing over Discord. Voice happens on Discord; Mediarr only
keeps everyone's video in step. The overriding goal is **no desync**: everyone sees the same frame, and a
pause or seek lands for everyone within a fraction of a second.

## Goals
- A host starts a party from the player and invites other Mediarr accounts (searchable list) or makes a
  guest link for someone without an account.
- Invited accounts get a popup anywhere in Mediarr ("jacob invited you to watch …", Join / Dismiss) and the
  invite stays in a new notifications menu (🔔 with a count).
- Anyone in the party can play, pause and seek; it applies to everyone.
- Late joiners land where everyone else is.
- If anyone buffers, everyone waits, then resumes together.
- Each viewer picks their own audio track, subtitles and quality.

## Non-goals
- No chat, reactions or voice.
- No free-form queue or playlist. A party is one movie, or one show watched episode by episode (see "Answers from the user").
- No host-only controls or permissions inside a party.
- Notifications other than watch party invites (the menu is built so more kinds can be added later).

## Anti-goals (a failure even if it works)
- A guest link that reaches anything but that one party's video: no library, no other titles, no API beyond
  the party's own stream, no account pages. Ending the party must kill the link.
- Visible drift between viewers during normal playback.
- A party that silently keeps converting streams after everyone has left.

## Decisions made with the user
- **Real-time channel:** websockets (user asked for the fastest option to prevent desync). One socket per
  viewer per party, used both for commands and state pushes.
- **Who may control:** everyone in the party.
- **Who may make guest links:** any account (proposed; the user didn't object). A link is scoped to one party.
- **Inviting:** an Invite button in the player opens a panel listing users with a search box; each row has
  Invite (→ "✓ Invited"). The panel's bottom has "Guest invite" with a Copy button.
- **Invite delivery:** popup on whatever page the invitee has open, plus a notifications menu (bell next to
  the account at the bottom of the sidebar; inside the ☰ menu on phones). Ended parties show as "Ended" and
  can't be joined.
- **Guest view:** the player only. No back button, no next-episode button, no sidebar, no other pages.

## Approaches considered (sync channel)
1. Server-sent events for pushes + ordinary POSTs for actions. ~0.1–0.3 s, no new dependency.
2. **Websockets (chosen).** Same push speed, actions skip per-request setup (a few tens of ms faster),
   one connection. Costs a dependency (`@fastify/websocket`) and its own auth handling and keep-alive pings
   (Cloudflare closes idle sockets after ~100 s).
3. Polling every second. Simplest, but up to 1 s late. Rejected: noticeable desync.

## How sync works (my design, the builder may refine)
- **Clock offset:** on connect, and every 30 s, the client pings with its time; the server replies with its
  time; the client keeps the offset from the lowest-latency sample of the last few.
- **Party state on the server** (authoritative): `{ playing, position, atServerTime, version }`. The current
  position is `position + (playing ? now − atServerTime : 0)`.
- **Commands:** `play`, `pause`, `seek(position)`. The server stamps them with a server time slightly in the
  future for `play` (≈ max viewer latency, capped ~300 ms) so everyone starts on the same instant, bumps
  `version`, and broadcasts the new state. Commands from a client carry the `version` they saw; stale ones
  (older version) still apply (last writer wins), ties broken by arrival order.
- **Drift correction on each client** (every ~500 ms while playing): expected = state position for
  now(server); drift = video.currentTime − expected.
  - |drift| < 0.1 s: leave it.
  - 0.1–1 s: playbackRate 0.95 / 1.05 until within 0.05 s, then back to 1.
  - > 1 s: set currentTime directly.
- **Buffering:** when a viewer's video goes into `waiting` (not caused by a seek just issued) for > 300 ms,
  it sends `buffering`; the server pauses the party ("Waiting for alex…" shown to all). When every viewer
  reports ready (`canplay` with ≥ 2 s buffered ahead), the server resumes with a scheduled play.
  A viewer who stays buffering > 20 s is skipped (party resumes; they catch up via drift correction / jump).
- **Late join:** the joiner gets the state on connect and starts its stream at the current position
  (existing `startAt`), then drift-corrects.
- **Echo prevention:** state applied from the server must not re-send as a user action (the player's
  pause/seek handlers distinguish user input from programmatic changes).

## Server pieces
- `watch_parties` (in memory is fine; parties don't survive a restart): id, host user, kind+id of the title,
  state, members (user id or guest id), created/last-active.
- `notifications` table (persisted): id, user_id, kind ('party_invite'), payload JSON (party id, title,
  from username), created_at, read_at. Endpoints for the current user: list, unread count, mark read,
  dismiss. Added to `USER_ALLOWED`.
- Invite list endpoint for any signed-in user: id + username only of other accounts (never roles or other
  details), filtered to accounts allowed to see the title (NSFW setting).
- Guest links: `/party/<partyId>?g=<random token>` (token ≥ 128 bits, stored hashed with the party). The
  token grants only: the party socket, `info`/`start`/HLS/subtitle/font/trickplay routes for that party's
  title, and nothing else. Implemented as a separate guest principal checked by the security hook, not as a
  user account. All guest access ends when the party ends.
- Each viewer (guest included) gets their own playback session through the existing `createSession`, so
  copy mode / conversion and the conversion limit work as today. The "one stream per account" rule stays;
  guests count as their own principal. Remote bitrate cap applies to guests as to anyone remote.
- Party ends when the host leaves and nobody is left, or after 10 min with no one connected (my call; the
  user agreed the party ends when the host leaves or after being empty for a while: the host leaving with
  friends still watching keeps it going, so friends aren't cut off mid-episode).

## Web pieces
- Player: Invite button (👥) and "N watching" indicator; "Waiting for X…" overlay while someone buffers.
- Invite panel (users + search + Guest invite/Copy).
- Global invite popup (polls the unread notification count with the existing 3–5 s app polling) and a
  🔔 notifications menu.
- `/party/:id` route: for signed-in users it opens the normal player in party mode; for guests the bare
  player (no back / next episode / sidebar).

## Constraints
- Must work through the user's Cloudflare-fronted domain (websocket keep-alive ping every 30 s).
- Existing auth: cookie sessions + `x-requested-with` CSRF header; everything not in `USER_ALLOWED` is
  admin-only. Websocket upgrade must check the session cookie (or guest token) and the Origin header.
- Tests with vitest; test copy on port 7990 for manual checks; never against the real instance.

## Calls settled after the builder check (mine, for the user to check)
- **Ending:** a party ends only when nobody has been connected for 10 minutes (so a host reload or dropped
  connection doesn't kill it), or when its host presses **End party** (ends it for everyone and kills guest
  links). Everyone has **Leave**. "Anyone can control" covers play/pause/seek; ending is the one host control.
- **Guest links are multi-use:** each browser that opens one becomes its own guest (own principal, own
  stream), asked for a display name on join (default "Guest 2", "Guest 3"…). Names show in the "N watching"
  list and "Waiting for X…". The host's member list shows who's in.
- **Accounts:** any signed-in account allowed to see the title can join via the party link, invited or not
  (the invite is just the delivery). Accounts not allowed to see the title (NSFW) can't join.

## Answers from the user after the builder check
- **Conversion limit:** party viewers skip `maxTranscodes` (a party is deliberate; everyone in it plays).
  A big party on a title that must be converted can load the server heavily for that evening; accepted.
- **End of episode:** the party moves to the next episode together. When the next-episode countdown fires
  or anyone presses Next, every member (guests included) switches to the next episode and the party
  continues there. This replaces "one title per party" in the non-goals: a party follows one show's episodes
  in order; there's still no free-form queue.
- **18+ titles and guests** (my pick; the user's reply didn't cover it, open to change): guest links can't
  be made for adult titles, and a party moving into an adult title isn't possible for a show anyway (adult
  is per title). The guest invite button is hidden for adult titles.

## Left to the builder
- Exact message shapes, file layout, UI styling (follow existing `styles.css` patterns).
- Rate limiting of commands per socket (some sane cap).
