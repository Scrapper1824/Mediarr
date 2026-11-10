# Mediarr

**Sonarr + Radarr + a Jellyfin-style player, in one lightweight app.** Request movies, shows and anime; Mediarr finds them through Prowlarr, downloads them with qBittorrent, names everything cleanly, keeps up with new episodes, and lets you watch it all in the browser, at home or away.

- **Requests**: Discover pages for movies, shows and anime (TMDB + AniList) with trending rows, a featured banner, ratings (TMDB, IMDb, Rotten Tomatoes, AniList, MyAnimeList, Kitsu) and trailers.
- **Smart searching**: Prowlarr search with careful release matching (seasons, absolute numbering, sequels, bundles), **Sub/Dub** for anime, and "download just the season you asked for" from bigger bundles.
- **Clean library**: each title gets its own folder; qBittorrent saves files straight under their final names (`Show - S01E05 - Title.mkv`). Several library folders per type, moving to a drive with room when one fills up.
- **Monitoring**: new episodes and seasons are grabbed as they air.
- **Watching**: play anything in your library, with FFmpeg converting on the fly (GPU accelerated), styled anime subtitles, audio/subtitle/quality menus, resume, Continue watching, **Skip intro / credits** and **seek-bar previews**.
- **Watchlists**: each user can connect their own **Simkl** and **AniList** lists.
- **Multi-user and secure**: accounts with roles, two-factor sign-in, brute-force lockout and strict browser protections. Built to sit behind HTTPS.
- **Windows-friendly**: runs in the background with a tray icon, can start with Windows, and **updates itself** from this repository's releases.

---

## Install

Needs **Node.js 22.13+**, **Git**, and the **GitHub CLI** (this repository is private), plus **FFmpeg** for watching.

```bash
winget install OpenJS.NodeJS.LTS Git.Git GitHub.cli Gyan.FFmpeg
gh auth login
gh auth setup-git
gh repo clone Scrapper1824/Mediarr
cd Mediarr
npm install
npm run build
npm start
```

Then open **http://localhost:7979**. The first time, the tray shows a **setup code** (also in `data\setup-code.txt`): you need it to create the first (admin) account.

`gh auth setup-git` lets Git (and Mediarr's update checks) use your GitHub sign-in without ever asking for a password.

### Running it

- `npm start`: on Windows, starts Mediarr in the background with an orange **M** in the system tray, and gives your terminal back. On macOS/Linux it runs in the terminal.
- `npm run console`: runs it in the terminal with live output (handy for troubleshooting).
- `start.bat`: same as `npm start` (installs and builds first if needed).

| Setting | How |
|---|---|
| Port | `PORT` environment variable (default 7979) |
| Data folder | `MEDIARR_DATA` (default `data\`: the database, keys, cache) |
| Listen only on this PC | `HOST=127.0.0.1` |
| Trusted proxy | `TRUST_PROXY` (see *Putting it on the internet*) |

## First-time setup

In **Settings**, the **Overview** page is a checklist that tests each connection.

1. **Library**: a folder for Movies, Shows and Anime (add more than one per type, e.g. one per drive). Use paths as qBittorrent sees them.
2. **Connections**:
   - **TMDB**: a free API key from themoviedb.org → Settings → API. Anime uses AniList (no key).
   - **OMDb** (optional): IMDb and Rotten Tomatoes ratings.
   - **Prowlarr**: URL and API key (Prowlarr → Settings → General).
   - **qBittorrent**: Web UI address, username and password (Tools → Options → Web UI must be on).
3. **Playback**: click **Test** to confirm FFmpeg and your GPU encoder (AMD AMF, NVIDIA NVENC or Intel Quick Sync).
4. **Watchlists** (optional): Simkl and AniList app IDs so users can connect their lists.

## Updating

When a new **release** is published on this repository, admins see **Update available** in the sidebar. Click it to read what's new, then **Update & restart**. Mediarr then:

1. downloads the release (a fast-forward to its tag, so your copy is never merged or overwritten)
2. reinstalls packages and rebuilds
3. restarts, and the page reloads by itself

If anything fails, the previous version is put back and keeps running, and the dialog shows what went wrong. Mediarr checks every 6 hours, or use **Settings → System → Updates → Check now**.

Updates are refused when this copy has its own uncommitted changes to Mediarr's files, so local edits are never lost.

### Publishing a release (for developers)

```bash
npm run release -- patch     # 0.1.0 → 0.1.1 (fixes)
npm run release -- minor     # 0.1.0 → 0.2.0 (features)
npm run release -- patch --dry-run
```

The release script:
1. checks there are no uncommitted changes and that you're on `main`
2. builds and runs the tests
3. bumps the version, commits, tags `vX.Y.Z` and pushes
4. creates the GitHub Release, with notes generated from the commits

Only published releases count as updates: pushes between releases are ignored.

## How it works

- **Request**: Discover → Movies / Shows / Anime → Request.
  - Shows and anime let you tick seasons; anime lets you pick **Sub** or **Dub**. The ticked seasons are always downloaded.
  - "Also get new episodes & seasons as they air" only controls future episodes.
  - While a search runs, the title's page shows what it's doing and then the result.
- **Search**: Prowlarr results are filtered and ranked (resolution, seeders, size limits, no CAMs, right episode/season, sub/dub, sequels told apart). The ☰ buttons open an interactive search to pick a release by hand.
- **Download**: the best release goes to qBittorrent (category `mediarr`, tag `mediarr-<id>`), saved straight into the title's own folder. Before that, Mediarr checks the drive has room, and moves the title to another of its library folders if it doesn't.
- **Clean names while downloading**: as soon as qBittorrent knows the files, Mediarr renames them to the final layout:
  - `Movies\Dune (2021)\Dune (2021) [1080p].mkv`
  - `Shows\Severance (2022)\Season 01\Severance (2022) - S01E05 - Episode Title.mkv`
  - `Anime\Frieren\Season 01\Frieren - S01E05.mkv`

  Subtitles follow their video. Junk stays in the torrent's folder, which is deleted after import.
- **Import**: when it finishes, the torrent is removed from qBittorrent (files kept, seeding stops) and the episodes are marked as downloaded.
- **Anime seasons**: an anime is one series built from its AniList sequel chain, stepping over OVAs and movies.
  - "Part 2" cours are merged into their season.
  - Standalone sequels that release groups call "Season 2" are matched too.
- **Sub vs Dub**:
  - **Dub** only accepts releases marked Dub / Dual Audio / Multi-Audio.
  - **Sub** rejects dub-only releases and prefers plain subbed ones.
- **Monitoring**: every 30 minutes (configurable), monitored titles refresh their episode lists and search for aired episodes with no file. Missing ones are retried every 6 hours.

### Bundles

When there's no pack for just the season you asked for, Mediarr widens the search: the bare show name, then "complete", "batch" and "season". A bigger bundle that **includes** your season is never downloaded on its own. Instead the show's page asks **"No pack found for just Season N. Download one instead?"**, offering:

- **Just Season N** (recommended): every other file (other seasons, NCOP/NCED, extras) is set to *Do not download* in qBittorrent. If Mediarr can't tell which files are which, it downloads everything rather than risk skipping something you want.
- **Whole bundle**: downloads everything and adds the extra seasons to your library.

Season naming it understands:

| Style | Examples |
|---|---|
| Single | `S02`, `Season 2`, `2nd Season`, `Second Season`, `Season Two`, `Series 2` (UK), `Saison 2`, `Temporada 2`, `Staffel 2`, `Stagione 2` |
| Ranges | `S01-S05`, `S01 - S05`, `S01~S03`, `S01-03`, `S1-3`, `Seasons 1-5`, `Seasons 1 to 3`, `Season 1 - Season 3`, `1st-3rd Season`, `Staffel 1 bis 3`, `Saisons 1 à 3`, `S01E01-S03E10` |
| Lists | `S01+S02`, `S1 & S2`, `S01, S02, S03`, `S01.S02.S03`, `Season 1 & 2`, `Seasons 1, 2 and 3`, `Season 1+2+3`, `1st & 2nd Season` |
| Whole show | `Complete Series`, `The Complete Series`, `Complete Collection`, `Box Set`, `Boxset`, `All Seasons`, `Full Series`, `Intégrale`, a year span like `(2008-2013)` |
| Anime batches | `[Batch]`, `01-24`, `01~24`, absolute ranges across seasons (`01-48`) |

`Season 2 - 05` (spaced dash) stays "season 2, episode 5", and `Title 2 - 06` is episode 6 of "Title 2".

## Watching

Press **▶** on any downloaded movie or episode.

- **Direct play or convert**: files the browser can play as they are stream directly. Everything else (MKV, HEVC 10-bit, multiple audio tracks…) is converted on the fly to HLS by FFmpeg, on your GPU when available.
- **Quality**: **Auto** plays full quality at home, and stays under the *Away-from-home limit* (Settings → Playback) when you're watching remotely. 1080p / 720p / 480p can be picked by hand.
- **Audio and subtitles** (CC button):
  - anime picks the dub or the original audio to match your Sub/Dub choice
  - ASS subtitles are drawn with their original fonts and styling
  - picture subtitles (PGS) are burned in
- **Skip intro / credits**: found from chapter names, or by comparing the audio of a season's episodes (the opening and ending songs repeat).
- **Seek-bar previews**: a thumbnail every 10 seconds.

  Both are made in the background after import, and for your existing library a minute after Mediarr starts.
- **Resume and Continue watching**: per user. Past 90% a title counts as watched, and the next episode shows up next.

## Watchlists

**Settings → Watchlists**: each user connects their own **Simkl** (movies, shows, anime) and/or **AniList** (anime) account.

- The **Watchlist** page shows each user's lists by status.
- The **＋ Watchlist** button on any title adds it or moves it.
- Tokens stay on the server, encrypted, and are never sent to the browser.

## Security

Mediarr needs an account before anything works. Every API route refuses requests without a valid session (tests enforce this for every route).

- **First run:** creating the first account needs the **setup code**, so nobody who reaches the site before you can claim it.
- **Passwords:** at least 12 characters, hashed with scrypt. Wrong usernames and wrong passwords get the same answer.
- **Sessions:** random tokens; only their hashes are stored. Cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` over HTTPS. You're signed out after 7 days idle or 30 days total.
- **Brute force:** 5 failed logins for an account, or 10 from one IP, lock it out for 15 minutes.
- **Two-factor** (recommended before going public): Settings → My account.
- **Browser protections:** cross-site request forgery is blocked. Strict security headers are sent (CSP, no framing, `nosniff`, `no-referrer`, HSTS on HTTPS), and API responses are never cached.
- **Users and admins:**
  - **Users** can browse, request, search, watch, and manage their own watchlists and account.
  - **Admins** can do everything, including settings, users and updates.
  - New routes are admin-only unless explicitly opened to users.
- **Locked out?** Run `npm run reset-password` on the Mediarr PC, or use the tray's **Reset password…**.

### Putting it on the internet

- **Always use HTTPS.**
  - Nginx Proxy Manager: proxy to `http://<this-pc>:7979` with *Force SSL*.
  - Cloudflare Tunnel: point the hostname at `http://localhost:7979`.

  Cloudflare's free plan restricts streaming lots of video through its tunnel, so for watching away from home a direct port-forward via Nginx Proxy Manager, or Tailscale, may suit better.
- **Real client IPs:** only `X-Forwarded-*` from this machine is trusted by default. If the proxy runs in Docker or on another machine, set `TRUST_PROXY` to its address (e.g. `172.16.0.0/12` or `192.168.1.50`). Never trust everyone.
- **Only reachable through the proxy:** with the proxy on the same PC, set `HOST=127.0.0.1`.
- **Cloudflare Zero Trust Access** in front adds a second, independent login.
- **Protect the `data` folder:** your API keys and users live in `data\mediarr.db`. It is never part of this repository.

## Running in the background (Windows)

`npm start` (or `start.bat`, or `tray\Mediarr.vbs`) runs Mediarr with no console window and an orange **M** in the system tray (grey means stopped). Right-click it for:

- **Open Mediarr**: double-clicking the icon does the same
- **Start / Stop / Restart**
- **Reset password…**
- **Start when Windows starts**: the same setting as Settings → System
- **Open log**: `data\mediarr.log`
- **Quit**

The tray notifies you if Mediarr crashes. After an update it starts the new version by itself.

## Development

```bash
npm run dev     # UI with hot reload at http://localhost:5173, API on 7979
npm test        # server tests (FFmpeg tests run when FFmpeg is installed)
npm run build
```

| Part | Stack |
|---|---|
| `server/` | Fastify + TypeScript, Node's built-in SQLite |
| `web/` | React + Vite + TanStack Query |
| `tray/` | the Windows tray (PowerShell) |
| `scripts/` | start and release helpers |
