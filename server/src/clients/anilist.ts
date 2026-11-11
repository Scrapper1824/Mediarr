import type { AnimeSeason } from '../core/animeMatch.js';
import { fetchJson } from './http.js';
import type { BrowseRow, FeaturedItem, SearchResult } from './tmdb.js';

const URL_ = 'https://graphql.anilist.co';

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await fetchJson<{ data: T; errors?: { message: string }[] }>(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (r.errors?.length) throw new Error(`AniList: ${r.errors[0].message}`);
  return r.data;
}

const FIELDS = `
  id
  bannerImage
  title { romaji english native }
  synonyms
  format
  status
  episodes
  seasonYear
  startDate { year month day }
  endDate { year month day }
  coverImage { large }
  description(asHtml: false)
  nextAiringEpisode { episode airingAt }
  relations { edges { relationType node { id format type } } }
`;

/** Formats that make up the main seasons of a series. Movies, OVAs and specials stay separate. */
const MAIN_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);
/** A second cour released as its own AniList entry ("... Part 2") is merged into the previous season. */
const SPLIT_COUR = /\b(?:part|cour)\s*(?:[2-9]|ii|iii|iv)\b|\b(?:2nd|3rd|second|third)\s*cour\b/i;

interface AnimeEntry {
  anilistId: number;
  title: string;
  romaji: string;
  titles: string[];
  year: number | null;
  poster: string | null;
  banner: string | null;
  overview: string;
  status: string;
  format: string;
  episodes: { episode: number; airDate: string | null }[];
  prequels: Related[];
  sequels: Related[];
}

interface Related {
  id: number;
  format: string;
}

export interface AnimeSeries {
  anilistId: number;
  title: string;
  altTitles: string[];
  year: number | null;
  poster: string | null;
  /** The banner of the first season that has one (later seasons often share the look). */
  backdrop: string | null;
  overview: string;
  status: string;
  seasons: AnimeSeason[];
  episodes: { season: number; episode: number; absolute: number; airDate: string | null }[];
}

const stripHtml = (s: string | null) => (s ?? '').replace(/<[^>]+>/g, '').trim();
const dateOf = (d: { year: number | null; month: number | null; day: number | null } | null) =>
  d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, '0')}-${String(d.day ?? 1).padStart(2, '0')}` : null;
const CJK = /[぀-ヿ㐀-鿿가-힯]/;

function displayTitle(t: { romaji: string; english: string | null }) {
  return t.english || t.romaji;
}

/** Prequels/sequels of any anime format; OVAs and movies often sit between two TV seasons. */
function related(m: any, type: 'PREQUEL' | 'SEQUEL'): Related[] {
  return (m.relations?.edges ?? [])
    .filter((e: any) => e.relationType === type && e.node.type === 'ANIME')
    .map((e: any) => ({ id: e.node.id as number, format: e.node.format as string }));
}

export async function searchAnime(search: string): Promise<SearchResult[]> {
  const data = await gql<{ Page: { media: any[] } }>(
    `query ($search: String) { Page(perPage: 25) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { ${FIELDS} } } }`,
    { search },
  );
  const media = data.Page.media;

  // Group main-format seasons that are linked as prequel/sequel into one result.
  const parent = new Map<number, number>(media.map((m) => [m.id, m.id]));
  const find = (id: number): number => (parent.get(id) === id ? id : find(parent.get(id)!));
  const byId = new Map(media.map((m) => [m.id, m]));
  for (const m of media) {
    for (const other of [...related(m, 'SEQUEL'), ...related(m, 'PREQUEL')]) {
      if (byId.has(other.id)) parent.set(find(other.id), find(m.id));
    }
  }
  // One card for all main seasons of a franchise; movies/OVAs keep their own cards.
  const groups = new Map<string, any[]>();
  for (const m of media) {
    const key = MAIN_FORMATS.has(m.format) ? `main-${find(m.id)}` : `own-${m.id}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }

  const startKey = (m: any) => (m.startDate?.year ?? 9999) * 10000 + (m.startDate?.month ?? 12) * 100 + (m.startDate?.day ?? 31);
  const results: SearchResult[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => startKey(a) - startKey(b));
    const first = group[0];
    const isSeries = MAIN_FORMATS.has(first.format);
    const seasonCount = isSeries ? group.filter((m) => !SPLIT_COUR.test(`${m.title.romaji} ${m.title.english ?? ''}`)).length : 0;
    results.push({
      type: 'anime',
      anilistId: first.id,
      title: displayTitle(first.title),
      year: first.seasonYear ?? first.startDate?.year ?? null,
      poster: first.coverImage?.large ?? null,
      overview: stripHtml(first.description),
      extra: [
        isSeries ? (seasonCount > 1 ? `${seasonCount} seasons` : 'TV') : first.format,
        !isSeries || seasonCount <= 1 ? (first.episodes ? `${first.episodes} eps` : null) : null,
        first.title.english ? first.title.romaji : null,
      ]
        .filter(Boolean)
        .join(' · '),
      altTitles: [...new Set(group.flatMap((m) => [m.title.romaji, m.title.english, m.title.native, ...(m.synonyms ?? [])]).filter(Boolean))] as string[],
    });
  }
  return results;
}

async function getEntry(id: number): Promise<AnimeEntry> {
  const data = await gql<{ Media: any }>(
    `query ($id: Int) { Media(id: $id, type: ANIME) { ${FIELDS} airingSchedule(perPage: 50) { nodes { episode airingAt } } } }`,
    { id },
  );
  const m = data.Media;
  const schedule = new Map<number, string>();
  for (const n of m.airingSchedule?.nodes ?? []) {
    schedule.set(n.episode, new Date(n.airingAt * 1000).toISOString());
  }

  // Total known episodes: the final count if known, otherwise everything aired or scheduled so far.
  const lastScheduled = Math.max(0, ...schedule.keys());
  const airedSoFar = m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : 0;
  const total = m.episodes ?? Math.max(airedSoFar, lastScheduled);
  const fallbackDate = m.status === 'NOT_YET_RELEASED' ? null : dateOf(m.endDate) ?? dateOf(m.startDate);

  const episodes = [];
  for (let ep = 1; ep <= total; ep++) {
    let airDate = schedule.get(ep) ?? null;
    if (!airDate) {
      // Unscheduled episodes before the next airing one have already aired.
      if (m.nextAiringEpisode && ep < m.nextAiringEpisode.episode) airDate = dateOf(m.startDate);
      else if (!m.nextAiringEpisode) airDate = fallbackDate;
    }
    episodes.push({ episode: ep, airDate });
  }

  const titles = [m.title.english, m.title.romaji, ...(m.synonyms ?? [])].filter(
    (t: string | null, i: number, a: (string | null)[]) => t && a.indexOf(t) === i && !CJK.test(t),
  );

  return {
    anilistId: m.id,
    title: displayTitle(m.title),
    romaji: m.title.romaji,
    titles,
    year: m.seasonYear ?? m.startDate?.year ?? null,
    poster: m.coverImage?.large ?? null,
    banner: m.bannerImage ?? null,
    overview: stripHtml(m.description),
    status: m.status,
    format: m.format,
    episodes,
    prequels: related(m, 'PREQUEL'),
    sequels: related(m, 'SEQUEL'),
  };
}

/** The nearest TV/ONA entry in one direction, stepping over OVAs/movies/specials in between. */
async function nextMain(from: AnimeEntry, dir: 'prequels' | 'sequels', seen: Set<number>): Promise<AnimeEntry | null> {
  let frontier = from[dir];
  for (let depth = 0; depth < 5; depth++) {
    const main = frontier.find((r) => MAIN_FORMATS.has(r.format) && !seen.has(r.id));
    if (main) {
      seen.add(main.id);
      return getEntry(main.id);
    }
    const bridge = frontier.find((r) => !seen.has(r.id));
    if (!bridge) return null;
    seen.add(bridge.id);
    frontier = (await getEntry(bridge.id))[dir];
  }
  return null;
}

/**
 * Builds a whole series from any of its entries: walks back to the first TV season,
 * then forward through sequels. Each main entry becomes a season.
 */
/** The first banner among these AniList entries (in the order given), in one request. */
export async function animeBanner(ids: number[]): Promise<string | null> {
  if (!ids.length) return null;
  const data = await gql<{ Page: { media: { id: number; bannerImage: string | null }[] } }>(
    `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { id bannerImage } } }`,
    { ids },
  );
  const byId = new Map(data.Page.media.map((m) => [m.id, m.bannerImage]));
  for (const id of ids) if (byId.get(id)) return byId.get(id)!;
  return null;
}

export async function getAnimeSeries(id: number): Promise<AnimeSeries> {
  const seen = new Set<number>();
  let root = await getEntry(id);
  seen.add(root.anilistId);

  const chain: AnimeEntry[] = [];
  if (MAIN_FORMATS.has(root.format)) {
    for (let i = 0; i < 15; i++) {
      const prev = await nextMain(root, 'prequels', seen);
      if (!prev) break;
      root = prev;
    }
    chain.push(root);
    let cur = root;
    for (let i = 0; i < 25; i++) {
      const next = await nextMain(cur, 'sequels', seen);
      if (!next) break;
      chain.push(next);
      cur = next;
    }
  } else {
    chain.push(root); // a movie/OVA on its own
  }

  const seasons: AnimeSeason[] = [];
  const episodes: AnimeSeries['episodes'] = [];
  let absolute = 0;
  for (const entry of chain) {
    const prev = seasons[seasons.length - 1];
    const merge = prev && SPLIT_COUR.test(entry.titles.join(' '));
    const season = merge ? prev : {
      season: seasons.length + 1,
      anilistIds: [],
      title: entry.title,
      titles: [],
      episodes: 0,
      offset: absolute,
      year: entry.year,
    };
    if (!merge) seasons.push(season);
    season.anilistIds.push(entry.anilistId);
    season.titles.push(...entry.titles.filter((t) => !season.titles.includes(t)));
    for (const e of entry.episodes) {
      season.episodes++;
      absolute++;
      episodes.push({ season: season.season, episode: season.episodes, absolute, airDate: e.airDate });
    }
  }

  const first = chain[0];
  const last = chain[chain.length - 1];
  const allTitles = [...new Set(chain.flatMap((c) => c.titles))];
  return {
    anilistId: first.anilistId,
    title: first.title,
    altTitles: [first.title, ...allTitles.filter((t) => t !== first.title)],
    year: first.year,
    poster: first.poster,
    backdrop: chain.find((c) => c.banner)?.banner ?? null,
    overview: first.overview,
    status: last.status,
    seasons,
    episodes,
  };
}

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const;
const seasonLabel = (s: string) => s[0] + s.slice(1).toLowerCase();

/** The anime season a date falls in (Winter = Jan–Mar, Spring = Apr–Jun, ...). */
export function animeSeasonOf(d: Date): { season: (typeof SEASONS)[number]; year: number } {
  return { season: SEASONS[Math.floor(d.getMonth() / 3)], year: d.getFullYear() };
}

function toBrowseResult(m: any): SearchResult {
  return {
    type: 'anime',
    anilistId: m.id,
    title: displayTitle(m.title),
    year: m.seasonYear ?? m.startDate?.year ?? null,
    poster: m.coverImage?.large ?? null,
    overview: stripHtml(m.description),
    extra: browseExtra(m),
  };
}

const BROWSE_FORMAT: Record<string, string> = { MOVIE: 'Movie', TV_SHORT: 'TV short', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music video' };

/** "ONA · 12 eps", "1,180 eps" for a show still airing (what's out so far), "Movie" for a film. */
export function browseExtra(m: { format?: string | null; episodes?: number | null; nextAiringEpisode?: { episode: number } | null }): string | undefined {
  const format = m.format && m.format !== 'TV' ? (BROWSE_FORMAT[m.format] ?? m.format) : null;
  const count = m.episodes ?? (m.nextAiringEpisode && m.nextAiringEpisode.episode > 1 ? m.nextAiringEpisode.episode - 1 : null);
  const eps = m.format === 'MOVIE' || !count ? null : `${count.toLocaleString('en-US')} ep${count === 1 ? '' : 's'}`;
  return [format, eps].filter(Boolean).join(' · ') || undefined;
}

/** Curated lists for the Discover page: trending, this season, next season, popular, top rated. */
export async function browseAnime(now = new Date()): Promise<BrowseRow[]> {
  const cur = animeSeasonOf(now);
  const nextIdx = (SEASONS.indexOf(cur.season) + 1) % 4;
  const next = { season: SEASONS[nextIdx], year: nextIdx === 0 ? cur.year + 1 : cur.year };
  const BROWSE_FIELDS = `id title { romaji english } format episodes nextAiringEpisode { episode } seasonYear startDate { year } coverImage { large } description(asHtml: false)`;
  const data = await gql<Record<string, { media: any[] }>>(
    `query ($season: MediaSeason, $year: Int, $nextSeason: MediaSeason, $nextYear: Int) {
      trending: Page(perPage: 20) { media(type: ANIME, isAdult: false, sort: TRENDING_DESC) { ${BROWSE_FIELDS} } }
      thisSeason: Page(perPage: 20) { media(type: ANIME, isAdult: false, season: $season, seasonYear: $year, sort: POPULARITY_DESC) { ${BROWSE_FIELDS} } }
      nextSeason: Page(perPage: 20) { media(type: ANIME, isAdult: false, season: $nextSeason, seasonYear: $nextYear, sort: POPULARITY_DESC) { ${BROWSE_FIELDS} } }
      popular: Page(perPage: 20) { media(type: ANIME, isAdult: false, sort: POPULARITY_DESC) { ${BROWSE_FIELDS} } }
      topRated: Page(perPage: 20) { media(type: ANIME, isAdult: false, sort: SCORE_DESC) { ${BROWSE_FIELDS} } }
    }`,
    { season: cur.season, year: cur.year, nextSeason: next.season, nextYear: next.year },
  );
  const row = (id: string, title: string) => ({ id, title, items: (data[id]?.media ?? []).filter((m) => m.coverImage?.large).map(toBrowseResult) });
  return [
    row('trending', 'Trending now'),
    row('thisSeason', `This season · ${seasonLabel(cur.season)} ${cur.year}`),
    row('nextSeason', `Next season · ${seasonLabel(next.season)} ${next.year}`),
    row('popular', 'All-time popular'),
    row('topRated', 'Top rated'),
  ];
}

/** Trending anime with wide banner art for the Discover banner (AniList has no title logos). */
export async function featuredAnime(): Promise<FeaturedItem[]> {
  const data = await gql<{ Page: { media: any[] } }>(
    `query { Page(perPage: 25) { media(type: ANIME, isAdult: false, sort: TRENDING_DESC) {
      id title { romaji english } format episodes seasonYear startDate { year } averageScore genres
      bannerImage coverImage { extraLarge large } description(asHtml: false)
    } } }`,
    {},
  );
  return data.Page.media
    .filter((m) => m.bannerImage)
    .slice(0, 6)
    .map((m) => ({
      ...toBrowseResult(m),
      // The large cover is shown sharp beside the (low-res) banner.
      poster: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
      backdrop: m.bannerImage,
      logo: null,
      rating: m.averageScore ? m.averageScore / 10 : null,
      genres: (m.genres ?? []).slice(0, 3),
      facts: [m.format && m.format !== 'TV' ? m.format.replace('_', ' ') : null, m.episodes ? `${m.episodes} eps` : null].filter(Boolean) as string[],
      certification: null,
    }));
}

export interface AiringInfo {
  format: string | null;
  status: string | null;
  /** Total episodes, when known. */
  episodes: number | null;
  /** The next episode to air in Japan (with simulcast subs). */
  next: { episode: number; at: string } | null;
  /** Every scheduled episode still to come. */
  upcoming: { episode: number; at: string }[];
  startDate: string | null;
}

/** When an anime's episodes air: what's out and what's scheduled (AniList's own schedule, delays included). */
export async function airingFor(id: number): Promise<AiringInfo> {
  const data = await gql<{ Media: any }>(
    `query ($id: Int) { Media(id: $id, type: ANIME) {
      format status episodes startDate { year month day }
      nextAiringEpisode { episode airingAt }
      airingSchedule(notYetAired: true, perPage: 50) { nodes { episode airingAt } }
    } }`,
    { id },
  );
  const m = data.Media;
  const iso = (t: number) => new Date(t * 1000).toISOString();
  return {
    format: m.format ?? null,
    status: m.status ?? null,
    episodes: m.episodes ?? null,
    next: m.nextAiringEpisode ? { episode: m.nextAiringEpisode.episode, at: iso(m.nextAiringEpisode.airingAt) } : null,
    upcoming: (m.airingSchedule?.nodes ?? []).map((n: { episode: number; airingAt: number }) => ({ episode: n.episode, at: iso(n.airingAt) })),
    startDate: dateOf(m.startDate),
  };
}

const FORMAT_LABEL: Record<string, string> = {
  TV: 'TV series', TV_SHORT: 'TV short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music video',
};
const STATUS_LABEL: Record<string, string> = {
  FINISHED: 'Finished', RELEASING: 'Airing', NOT_YET_RELEASED: 'Not yet released', CANCELLED: 'Cancelled', HIATUS: 'On hiatus',
};
const COUNTRY_LANGUAGE: Record<string, string> = { JP: 'ja', CN: 'zh', KR: 'ko', TW: 'zh' };

/** Full details of one AniList entry for the Discover details screen. */
export async function anilistDetails(id: number) {
  const data = await gql<{ Media: any }>(
    `query ($id: Int) { Media(id: $id, type: ANIME) {
      id idMal siteUrl title { romaji english native } format status episodes duration season seasonYear
      startDate { year month day } averageScore genres countryOfOrigin bannerImage trailer { id site }
      coverImage { extraLarge large } description(asHtml: false)
      studios(isMain: true) { nodes { name } }
      nextAiringEpisode { episode }
    } }`,
    { id },
  );
  const m = data.Media;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const episodes = m.episodes ?? (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : null);
  const runtime = m.duration
    ? m.format === 'MOVIE'
      ? `${Math.floor(m.duration / 60) ? `${Math.floor(m.duration / 60)}h ` : ''}${m.duration % 60}m`
      : `${m.duration} min per episode`
    : null;
  return {
    anilistId: m.id as number,
    idMal: (m.idMal as number | null) ?? null,
    url: m.siteUrl as string,
    title: displayTitle(m.title),
    originalTitle: (m.title.native as string) || (m.title.english ? (m.title.romaji as string) : null),
    year: m.seasonYear ?? m.startDate?.year ?? null,
    overview: stripHtml(m.description),
    poster: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
    backdrop: (m.bannerImage as string) ?? null,
    runtime,
    length: [
      FORMAT_LABEL[m.format] ?? null,
      m.format !== 'MOVIE' && episodes ? plural(episodes, 'episode') + (m.episodes ? '' : ' so far') : null,
    ].filter((x): x is string => !!x),
    status: STATUS_LABEL[m.status] ?? null,
    released: dateOf(m.startDate),
    originalLanguage: COUNTRY_LANGUAGE[m.countryOfOrigin] ?? null,
    genres: (m.genres ?? []) as string[],
    studios: (m.studios?.nodes ?? []).map((s: { name: string }) => s.name).slice(0, 3) as string[],
    // AniList also lists Dailymotion trailers; only YouTube ones can be played here.
    trailer: m.trailer?.site === 'youtube' && m.trailer.id ? { youtubeId: m.trailer.id as string, title: 'Trailer' } : null,
    rating: m.averageScore
      ? { source: 'anilist' as const, label: 'AniList', value: `${m.averageScore}%`, percent: m.averageScore as number, url: m.siteUrl as string }
      : null,
  };
}

// ---- A user's own AniList list (needs their token) ----

export type AniListStatus = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'DROPPED' | 'PAUSED' | 'REPEATING';

async function gqlAs<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const r = await fetchJson<{ data: T; errors?: { message: string; status?: number }[] }>(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (r.errors?.length) throw new Error(`AniList: ${r.errors[0].message}`);
  return r.data;
}

/** Who a token belongs to; throws when the token is invalid or expired. */
export async function viewer(token: string): Promise<{ id: number; name: string }> {
  const d = await gqlAs<{ Viewer: { id: number; name: string } }>(token, 'query { Viewer { id name } }', {});
  return d.Viewer;
}

export interface AniListEntry {
  entryId: number;
  status: AniListStatus;
  progress: number;
  anilistId: number;
  malId: number | null;
  title: string;
  year: number | null;
  poster: string | null;
  episodes: number | null;
}

export async function userAnimeList(token: string, userId: number): Promise<AniListEntry[]> {
  const d = await gqlAs<{ MediaListCollection: { lists: { entries: any[] }[] } }>(
    token,
    `query ($userId: Int) {
      MediaListCollection(userId: $userId, type: ANIME) {
        lists { entries { id status progress media { id idMal title { romaji english } seasonYear coverImage { large } episodes } } }
      }
    }`,
    { userId },
  );
  const seen = new Set<number>();
  const out: AniListEntry[] = [];
  // Custom lists repeat entries that are already in a status list.
  for (const list of d.MediaListCollection?.lists ?? []) {
    for (const e of list.entries ?? []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({
        entryId: e.id,
        status: e.status,
        progress: e.progress ?? 0,
        anilistId: e.media.id,
        malId: e.media.idMal ?? null,
        title: displayTitle(e.media.title),
        year: e.media.seasonYear ?? null,
        poster: e.media.coverImage?.large ?? null,
        episodes: e.media.episodes ?? null,
      });
    }
  }
  return out;
}

export async function saveEntry(token: string, mediaId: number, status: AniListStatus): Promise<void> {
  await gqlAs(token, 'mutation ($mediaId: Int, $status: MediaListStatus) { SaveMediaListEntry(mediaId: $mediaId, status: $status) { id } }', {
    mediaId,
    status,
  });
}

/** Removes a title from the user's list (nothing to do if it isn't on it). */
export async function deleteEntry(token: string, userId: number, mediaId: number): Promise<void> {
  let entryId: number | null = null;
  try {
    const d = await gqlAs<{ MediaList: { id: number } | null }>(
      token,
      'query ($userId: Int, $mediaId: Int) { MediaList(userId: $userId, mediaId: $mediaId) { id } }',
      { userId, mediaId },
    );
    entryId = d.MediaList?.id ?? null;
  } catch (err) {
    if (/not found/i.test((err as Error).message)) return;
    throw err;
  }
  if (entryId === null) return;
  await gqlAs(token, 'mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }', { id: entryId });
}

/** AniList ids for MyAnimeList ids (Simkl sometimes only knows the MAL id of an anime). */
export async function anilistIdsForMal(malIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < malIds.length; i += 50) {
    const chunk = malIds.slice(i, i + 50);
    const d = await gql<{ Page: { media: { id: number; idMal: number }[] } }>(
      'query ($ids: [Int]) { Page(perPage: 50) { media(idMal_in: $ids, type: ANIME) { id idMal } } }',
      { ids: chunk },
    );
    for (const m of d.Page?.media ?? []) out.set(m.idMal, m.id);
  }
  return out;
}
