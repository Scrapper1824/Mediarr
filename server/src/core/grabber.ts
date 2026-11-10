import path from 'node:path';
import { addTorrent } from '../clients/qbittorrent.js';
import { CATEGORIES, resolveTorrent, searchProwlarr, type ProwlarrRelease } from '../clients/prowlarr.js';
import {
  activeEpisodeIds,
  db,
  getEpisodes,
  getMedia,
  hasActiveDownload,
  logHistory,
  now,
  type EpisodeRow,
  type MediaRow,
  type SuggestionRow,
} from '../db.js';
import { getSettings } from '../settings.js';
import { matchAnime, standaloneSequel } from './animeMatch.js';
import { watchFiles } from './fileSelection.js';
import { ensureRoom } from './rootFolders.js';
import { isAired, mediaTitles, seasonsFor } from './library.js';
import { parseRelease } from './releaseParser.js';
import { coverageLabel, rankReleases, type ScoredRelease, type SearchScope } from './scoring.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** Indexer search works best on plain words: "Frieren: Beyond Journey’s End" -> "Frieren Beyond Journeys End". */
const searchable = (t: string) =>
  t
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Targeted queries: the season or episode asked for. */
function queriesFor(m: MediaRow, scope: SearchScope): string[] {
  const titles = [...new Set(mediaTitles(m).map(searchable))].slice(0, 2);
  if (m.type === 'anime' && scope.kind !== 'movie') {
    const all = seasonsFor(m);
    const info = all.find((s) => s.season === scope.season);
    const ep = scope.kind === 'episode' ? ` ${pad(scope.episode)}` : '';
    // A standalone sequel is often released as a later season of the original: "Cyberpunk Edgerunners S02".
    const sequel = scope.season === 1 ? standaloneSequel(all) : null;
    const asSeason = sequel
      ? [`${searchable(sequel.base)} S${pad(sequel.n)}${scope.kind === 'episode' ? `E${pad(scope.episode)}` : ''}`]
      : [];
    if (!info || info.season === 1) return [...titles.map((t) => t + ep), ...asSeason];
    // Later seasons: the season's own name ("... 2nd Season") plus the series name with SxxEyy.
    const seasonTitles = [...new Set(info.titles.map(searchable))].slice(0, 2);
    const sxe = scope.kind === 'episode' ? `S${pad(scope.season)}E${pad(scope.episode)}` : `S${pad(scope.season)}`;
    return [...new Set([...seasonTitles.map((t) => t + ep), `${titles[0]} ${sxe}`])];
  }
  return titles.map((t) => {
    if (scope.kind === 'movie') return m.year ? `${t} ${m.year}` : t;
    return scope.kind === 'episode' ? `${t} S${pad(scope.season)}E${pad(scope.episode)}` : `${t} S${pad(scope.season)}`;
  });
}

/**
 * Wider queries for bundles, which are usually named after the show alone:
 * "Show Complete Series", "Show S01-S05", "[Group] Show (Season 1+2) [Batch]".
 */
function broadQueriesFor(m: MediaRow): string[] {
  const titles = [...new Set(mediaTitles(m).map(searchable))].slice(0, 2);
  const [main, alt] = titles;
  const extra = m.type === 'anime' ? ['batch', 'complete'] : ['complete', 'season'];
  return [...titles, ...extra.map((w) => `${main} ${w}`), ...(alt ? [`${alt} ${extra[0]}`] : [])];
}

/** targeted = the season/episode asked for; broad = that plus show-wide queries that find bundles. */
export type SearchMode = 'targeted' | 'broad';
/** Per-run cache so the targeted and broad passes never repeat a Prowlarr query. */
export type QueryCache = Map<string, ProwlarrRelease[]>;

export async function searchReleases(
  m: MediaRow,
  scope: SearchScope,
  mode: SearchMode = 'targeted',
  cache: QueryCache = new Map(),
): Promise<ScoredRelease[]> {
  const queries = [...queriesFor(m, scope), ...(mode === 'broad' && scope.kind === 'season' ? broadQueriesFor(m) : [])];
  const all: ProwlarrRelease[] = [];
  const errors: string[] = [];
  for (const q of new Set(queries)) {
    try {
      if (!cache.has(q)) cache.set(q, await searchProwlarr(q, CATEGORIES[m.type]));
      all.push(...cache.get(q)!);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (!all.length && errors.length) throw new Error(errors[0]);
  return rankReleases(all, {
    type: m.type,
    titles: mediaTitles(m),
    year: m.year,
    animeAudio: m.anime_audio,
    scope,
    settings: getSettings(),
    animeSeasons: m.type === 'anime' ? seasonsFor(m) : undefined,
    seasonEpisodeCounts: m.type === 'show' ? episodeCounts(m.id) : undefined,
  });
}

function episodeCounts(mediaId: number): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const e of getEpisodes(mediaId)) if (e.season > 0) counts[e.season] = (counts[e.season] ?? 0) + 1;
  return counts;
}

/** Which of the media's episodes a release covers. */
export function episodesForRelease(m: MediaRow, title: string, episodes: EpisodeRow[]): EpisodeRow[] {
  if (m.type === 'movie') return [];
  const p = parseRelease(title);
  if (m.type === 'anime') {
    const match = matchAnime(p, seasonsFor(m));
    if (!match) return [];
    if (match.episodes === null) return episodes.filter((e) => match.seasons.includes(e.season));
    return episodes.filter((e) => match.episodes!.some((x) => x.season === e.season && x.episode === e.episode));
  }
  if (p.episodes.length) return episodes.filter((e) => e.season === p.season && p.episodes.includes(e.episode));
  if (p.isComplete) return episodes.filter((e) => e.season > 0);
  if (p.isSeasonPack) return episodes.filter((e) => p.seasons.includes(e.season));
  return [];
}

type GrabbableRelease = Pick<ProwlarrRelease, 'title' | 'indexer' | 'size' | 'magnetUrl' | 'downloadUrl'>;

export interface GrabOptions {
  /** Bundle wanted for some seasons only: tell qBittorrent to skip the other files. */
  selectFiles?: boolean;
}

export async function grabRelease(m: MediaRow, release: GrabbableRelease, episodeIds: number[], opts: GrabOptions = {}): Promise<number> {
  // A background search can outlive the series if it was removed meanwhile.
  const current = getMedia(m.id);
  if (!current) throw new Error(`${m.title} was removed from the library`);
  // Won't fit on the title's drive: move the title to another library folder with room first.
  m = await ensureRoom(current, release.size);
  // Straight into the media's own folder; once qBittorrent knows the files they get their clean names (watchFiles).
  const savePath = path.join(m.root_folder, m.folder_name);
  const r = db
    .prepare(`INSERT INTO downloads (media_id, episode_ids, release_title, indexer, size, save_path, select_files, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`)
    .run(m.id, JSON.stringify(episodeIds), release.title, release.indexer ?? null, release.size ?? null, savePath,
      opts.selectFiles ? 1 : 0, now(), now());
  const id = Number(r.lastInsertRowid);
  const tag = `mediarr-${id}`;
  db.prepare('UPDATE downloads SET tag = ? WHERE id = ?').run(tag, id);
  try {
    const source = await resolveTorrent(release);
    await addTorrent(source, { savePath, tag });
  } catch (err) {
    db.prepare("UPDATE downloads SET state = 'failed', error = ?, updated_at = ? WHERE id = ?").run((err as Error).message, now(), id);
    logHistory(m.id, 'failed', `Could not send "${release.title}" to qBittorrent: ${(err as Error).message}`);
    throw err;
  }
  // Anything grabbed for these seasons makes earlier bundle suggestions for them moot.
  const seasons = new Set(getEpisodes(m.id).filter((e) => episodeIds.includes(e.id)).map((e) => e.season));
  const clear = db.prepare("DELETE FROM suggestions WHERE media_id = ? AND season = ? AND status = 'pending'");
  for (const season of seasons) clear.run(m.id, season);
  logHistory(m.id, 'grabbed', `Grabbed "${release.title}" from ${release.indexer ?? 'indexer'}`);
  watchFiles(id);
  return id;
}

// ---- Bundle suggestions ----

const MAX_SUGGESTIONS = 3;

/** Stores the best bundles for a season so the user can choose one. Returns how many were stored. */
function suggestBundles(m: MediaRow, season: number, bundles: ScoredRelease[]): number {
  const dismissed = new Set(
    (db.prepare("SELECT title FROM suggestions WHERE media_id = ? AND status = 'dismissed'").all(m.id) as { title: string }[]).map(
      (r) => r.title,
    ),
  );
  const fresh = bundles.filter((b) => !dismissed.has(b.title)).slice(0, MAX_SUGGESTIONS);
  const previous = (
    db.prepare("SELECT title FROM suggestions WHERE media_id = ? AND season = ? AND status = 'pending'").all(m.id, season) as {
      title: string;
    }[]
  ).map((r) => r.title);

  db.prepare("DELETE FROM suggestions WHERE media_id = ? AND season = ? AND status = 'pending'").run(m.id, season);
  const known = m.type === 'anime' ? seasonsFor(m).map((s) => s.season) : Object.keys(episodeCounts(m.id)).map(Number);
  const ins = db.prepare(
    "INSERT INTO suggestions (media_id, season, title, label, release, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
  );
  for (const b of fresh) {
    const release = {
      title: b.title,
      indexer: b.indexer,
      size: b.size,
      seeders: b.seeders,
      magnetUrl: b.magnetUrl,
      downloadUrl: b.downloadUrl,
      score: b.score,
      covers: b.covers,
      resolution: b.parsed.resolution,
      audio: b.parsed.audio,
    };
    ins.run(m.id, season, b.title, coverageLabel(b.covers, known), JSON.stringify(release), now());
  }
  if (fresh.length && fresh.some((b) => !previous.includes(b.title))) {
    logHistory(m.id, 'suggested', `No Season ${season} pack found; ${fresh.length} bundle(s) that include it are waiting for your choice`);
  }
  return fresh.length;
}

/**
 * 'wanted' downloads only the episodes you want from the bundle (the season you asked for, plus any
 * other ticked seasons it contains); 'all' downloads the whole bundle.
 */
export type BundleMode = 'wanted' | 'all';

export async function acceptSuggestion(id: number, mode: BundleMode = 'wanted'): Promise<number> {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as SuggestionRow | undefined;
  if (!s) throw Object.assign(new Error('Suggestion not found'), { statusCode: 404 });
  const m = getMedia(s.media_id)!;
  const release = JSON.parse(s.release) as GrabbableRelease;
  const active = activeEpisodeIds(m.id);
  const inBundle = episodesForRelease(m, release.title, getEpisodes(m.id)).filter((e) => !e.has_file && !active.has(e.id));
  const ids = (mode === 'all' ? inBundle : inBundle.filter((e) => e.monitored || e.season === s.season)).map((e) => e.id);
  const downloadId = await grabRelease(m, release, ids, { selectFiles: mode === 'wanted' });
  db.prepare("UPDATE suggestions SET status = 'accepted' WHERE id = ?").run(id);
  // Other options for every season this download now covers are no longer needed.
  const covered = [...new Set(getEpisodes(m.id).filter((e) => ids.includes(e.id)).map((e) => e.season)), s.season];
  const clear = db.prepare("DELETE FROM suggestions WHERE media_id = ? AND season = ? AND status = 'pending'");
  for (const season of covered) clear.run(m.id, season);
  return downloadId;
}

export function dismissSuggestion(id: number) {
  db.prepare("UPDATE suggestions SET status = 'dismissed' WHERE id = ?").run(id);
}

// ---- Automatic search ----

export interface AutoSearchOptions {
  /** Ignore the re-search interval (manual search). */
  force?: boolean;
  episodeIds?: number[];
  /** Who started it, so only they get the "couldn't find" popup. */
  userId?: number;
}

const MAX_EPISODE_SEARCHES = 25;
const acceptable = (r: ScoredRelease) => !r.rejections.length;

/** What the last search for a media item is doing / found, for the UI. */
export interface SearchStatus {
  running: boolean;
  /** What a running search is doing right now ("Searching episode 3 of 25"). */
  step: string | null;
  message: string | null;
  finishedAt: string | null;
}

const statuses = new Map<number, SearchStatus>();

export function searchStatus(mediaId: number): SearchStatus {
  return statuses.get(mediaId) ?? { running: false, step: null, message: null, finishedAt: null };
}

interface Outcome {
  suggested: number;
  step: (text: string) => void;
  /** Why nothing was searched, when that's the case. */
  note: string | null;
  /** Every release seen (by guid) with its rejection reasons, to explain an empty result. */
  seenReleases: Map<string, string[]>;
  errors: string[];
  /** First season searched, so the UI can open a manual search for it. */
  season: number | null;
  seen: (ranked: ScoredRelease[]) => ScoredRelease[];
}

/** "Too big (12.3 GB)" -> "Too big", "Only 0 seeders" -> "Not enough seeders", for grouping. */
export function reasonKey(rejection: string): string {
  if (/^Only \d+ seeders/.test(rejection)) return 'Not enough seeders';
  return rejection.replace(/\s*\(.*\)\s*$/, '').trim();
}

export interface SearchEvent {
  id: number;
  mediaId: number;
  title: string;
  type: MediaRow['type'];
  /** The user who started the search. */
  userId: number | null;
  /** none = searched but nothing usable; idle = nothing to search; error = indexer/search failure. */
  kind: 'none' | 'idle' | 'error';
  message: string;
  results: number;
  reasons: { reason: string; count: number }[];
  season: number | null;
  at: string;
}

const events: SearchEvent[] = [];
let lastEventId = 0;

/** Outcomes of searches the user started that came back empty, newest last. */
export function searchEvents(after: number, userId: number): { latestId: number; events: SearchEvent[] } {
  return { latestId: lastEventId, events: after < 0 ? [] : events.filter((e) => e.id > after && e.userId === userId) };
}

function emitEvent(m: MediaRow, e: Omit<SearchEvent, 'id' | 'mediaId' | 'title' | 'type' | 'at'>) {
  if (e.userId === null) return; // nobody to tell (e.g. a background check)
  events.push({ id: ++lastEventId, mediaId: m.id, title: m.title, type: m.type, at: now(), ...e });
  if (events.length > 50) events.shift();
}

/** Searches for everything wanted on a media item and grabs the best releases. Returns number of grabs. */
export async function autoSearch(mediaId: number, opts: AutoSearchOptions = {}): Promise<number> {
  // One search per item at a time (a request and the monitor could otherwise overlap).
  if (statuses.get(mediaId)?.running) return 0;
  const status: SearchStatus = { running: true, step: 'Starting…', message: null, finishedAt: null };
  statuses.set(mediaId, status);
  const out: Outcome = {
    suggested: 0,
    note: null,
    step: (text) => (status.step = text),
    seenReleases: new Map(),
    errors: [],
    season: null,
    seen: (ranked) => {
      for (const r of ranked) out.seenReleases.set(r.guid || r.title, r.rejections);
      return ranked;
    },
  };
  let message: string;
  try {
    const grabs = await searchWanted(mediaId, opts, out);
    const results = out.seenReleases.size;
    const failedOnly = out.errors.length > 0 && results === 0;
    message = grabs
      ? `Sent ${grabs} release(s) to qBittorrent.`
      : out.suggested
        ? 'No exact match, but bundles that include it were found. Choose one below.'
        : failedOnly
          ? `Search failed: ${out.errors[0]}`
          : (out.note ?? 'No acceptable releases found yet. Mediarr will keep trying automatically.');
    // Only searches the user started get a popup; background checks stay quiet.
    const m = getMedia(mediaId);
    if (m && opts.force && !grabs && !out.suggested) {
      const counts = new Map<string, number>();
      for (const rejections of out.seenReleases.values()) {
        for (const key of new Set(rejections.map(reasonKey))) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      emitEvent(m, {
        userId: opts.userId ?? null,
        kind: failedOnly ? 'error' : out.note && results === 0 ? 'idle' : 'none',
        message,
        results,
        reasons: [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 6),
        season: out.season,
      });
    }
    return grabs;
  } catch (err) {
    message = `Search failed: ${(err as Error).message}`;
    const m = getMedia(mediaId);
    if (m && opts.force) emitEvent(m, { userId: opts.userId ?? null, kind: 'error', message, results: 0, reasons: [], season: out.season });
    throw err;
  } finally {
    statuses.set(mediaId, { running: false, step: null, message: message!, finishedAt: now() });
  }
}

async function searchWanted(mediaId: number, opts: AutoSearchOptions, out: Outcome): Promise<number> {
  const m = getMedia(mediaId);
  if (!m) throw new Error('Media not found');
  const s = getSettings();
  const stale = (last: string | null) =>
    opts.force || !last || Date.now() - new Date(last).getTime() > s.researchIntervalHours * 3600_000;

  if (m.type === 'movie') {
    if (m.has_file || hasActiveDownload(m.id)) {
      out.note = m.has_file ? 'Already downloaded.' : 'Already downloading.';
      return 0;
    }
    if (!opts.force && (!m.monitored || !stale(m.last_search))) return 0;
    db.prepare('UPDATE media SET last_search = ? WHERE id = ?').run(now(), m.id);
    out.step('Searching for the movie…');
    const best = out.seen(await searchReleases(m, { kind: 'movie' })).find(acceptable);
    if (!best) {
      if (!opts.force) return 0;
      logHistory(m.id, 'search', `No acceptable release found for ${m.title}`);
      return 0;
    }
    await grabRelease(m, best, []);
    return 1;
  }

  const all = getEpisodes(m.id);
  const active = activeEpisodeIds(m.id);
  const explicit = opts.episodeIds ? new Set(opts.episodeIds) : null;
  const wanted = all.filter(
    (e) =>
      !e.has_file &&
      !active.has(e.id) &&
      isAired(e.air_date) &&
      // Wanted (ticked) episodes are searched whether or not the series watches for new episodes.
      (explicit ? explicit.has(e.id) : e.monitored && e.season > 0) &&
      // A newly aired episode is always searched; otherwise respect the re-search interval.
      (stale(e.last_search) || (e.air_date && e.last_search && e.last_search < e.air_date)),
  );
  if (!wanted.length) {
    const ticked = all.filter((e) => (explicit ? explicit.has(e.id) : e.monitored && e.season > 0));
    out.note = !ticked.length
      ? 'Nothing to search: no seasons or episodes are ticked as wanted.'
      : ticked.every((e) => e.has_file || active.has(e.id))
        ? 'Everything wanted is already downloaded or downloading.'
        : ticked.some((e) => !isAired(e.air_date)) && ticked.every((e) => e.has_file || active.has(e.id) || !isAired(e.air_date))
          ? "The wanted episodes haven't aired yet. They'll be grabbed once they do."
          : 'Searched recently; will retry automatically.';
    return 0;
  }

  const markSearched = db.prepare('UPDATE episodes SET last_search = ? WHERE id = ?');
  for (const e of wanted) markSearched.run(now(), e.id);

  let grabs = 0;
  let suggested = 0;
  const covered = new Set<number>();
  const cache: QueryCache = new Map();
  const bySeason = new Map<number, EpisodeRow[]>();
  for (const e of wanted) bySeason.set(e.season, [...(bySeason.get(e.season) ?? []), e]);

  for (const [season, eps] of bySeason) {
    if (eps.every((e) => covered.has(e.id))) continue; // already in a bundle grabbed for an earlier season
    const airedInSeason = all.filter((e) => e.season === season && isAired(e.air_date));
    // Try a pack/batch when all (or most of a longer) aired season is missing.
    const mostlyMissing = eps.length === airedInSeason.length || (eps.length >= 6 && eps.length >= airedInSeason.length * 0.75);
    if (eps.length < 2 || !mostlyMissing) continue;
    const scope: SearchScope = { kind: 'season', season, episodes: eps.map((e) => e.episode) };
    try {
      // 1) A pack for exactly this season. 2) If none, widen the search to catch bundles.
      out.step(`Looking for a Season ${season} pack…`);
      out.season ??= season;
      let ranked = out.seen(await searchReleases(m, scope, 'targeted', cache));
      let best = ranked.find((r) => acceptable(r) && r.coverage === 'exact');
      if (!best) {
        out.step(`No Season ${season} pack yet. Looking for bigger bundles…`);
        ranked = out.seen(await searchReleases(m, scope, 'broad', cache));
        best = ranked.find((r) => acceptable(r) && r.coverage === 'exact');
      }
      if (best) {
        const ids = episodesForRelease(m, best.title, all).map((e) => e.id);
        // Season packs often carry extras (OVAs/OADs, NCOP/NCED, featurettes): skip those in qBittorrent.
        await grabRelease(m, best, ids, { selectFiles: true });
        ids.forEach((id) => covered.add(id));
        grabs++;
        continue;
      }
      // Bigger bundles (e.g. S1–S3) are never grabbed on their own: ask the user first.
      const bundles = ranked.filter((r) => acceptable(r) && r.coverage === 'bundle');
      if (bundles.length && suggestBundles(m, season, bundles)) {
        eps.forEach((e) => covered.add(e.id));
        suggested++;
      }
    } catch (err) {
      out.errors.push((err as Error).message);
      logHistory(m.id, 'failed', `Season ${season} search failed: ${(err as Error).message}`);
    }
  }

  let searches = 0;
  const toSearch = Math.min(MAX_EPISODE_SEARCHES, wanted.filter((e) => !covered.has(e.id)).length);
  for (const e of wanted) {
    if (covered.has(e.id)) continue;
    if (++searches > MAX_EPISODE_SEARCHES || !getMedia(m.id)) break;
    out.step(`Searching episode by episode: S${pad(e.season)}E${pad(e.episode)} (${searches} of ${toSearch})…`);
    try {
      out.season ??= e.season;
      const best = out.seen(await searchReleases(m, { kind: 'episode', season: e.season, episode: e.episode }, 'targeted', cache)).find(
        acceptable,
      );
      if (!best) continue;
      const ids = episodesForRelease(m, best.title, all)
        .filter((x) => !x.has_file)
        .map((x) => x.id);
      await grabRelease(m, best, ids.length ? ids : [e.id]);
      (ids.length ? ids : [e.id]).forEach((id) => covered.add(id));
      grabs++;
    } catch (err) {
      out.errors.push((err as Error).message);
      logHistory(m.id, 'failed', `Search for S${pad(e.season)}E${pad(e.episode)} failed: ${(err as Error).message}`);
    }
  }
  out.suggested = suggested;
  if (!grabs && !suggested && opts.force) {
    logHistory(m.id, 'search', `No acceptable releases for ${wanted.length} wanted episode(s) of ${m.title}`);
  }
  return grabs;
}
