import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// TMDB answers from a small fake catalogue (nothing goes online).
vi.mock('../clients/tmdb.js', async (orig) => {
  const real = await orig<typeof import('../clients/tmdb.js')>();
  const movies: Record<number, { title: string; year: number }> = { 438631: { title: 'Dune', year: 2021 }, 27205: { title: 'Inception', year: 2010 }, 603: { title: 'The Matrix', year: 1999 } };
  const movie = (id: number) => ({ type: 'movie' as const, tmdbId: id, title: movies[id].title, year: movies[id].year, poster: null, overview: '' });
  return {
    ...real,
    searchMovies: async (q: string) => Object.keys(movies).map(Number).filter((id) => movies[id].title.toLowerCase().includes(q.toLowerCase())).map(movie),
    searchShows: async (q: string) => (/severance/i.test(q) ? [{ type: 'show' as const, tmdbId: 95396, title: 'Severance', year: 2022, poster: null, overview: '' }] : []),
    getMovie: async (id: number) => ({ ...movie(id), originalTitle: null, status: 'Released', releaseDate: `${movies[id].year}-01-01` }),
    getShow: async () => ({ tmdbId: 95396, title: 'Severance', originalTitle: null, year: 2022, poster: null, overview: '', status: 'Returning Series', seasons: [{ season: 1 }] }),
    getShowEpisodes: async () => [1, 2, 3].map((episode) => ({ season: 1, episode, title: `Episode ${episode}`, airDate: '2022-02-18' })),
  };
});

const dbModule = await import('../db.js');
const { getEpisodes, getMedia, initDb } = dbModule;
// Read through the module: `db` is only set once initDb() runs.
const db = { prepare: (sql: string) => dbModule.db.prepare(sql) };
const { saveSettings } = await import('../settings.js');
const { addFolder, identifyFolder, linkFiles, parseFolderName, pickMatch, scanLibrary } = await import('./scanner.js');

let tmp: string;
const touch = (p: string, size = 10) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
};

beforeEach(() => {
  initDb(':memory:');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mediarr-scan-'));
  saveSettings({ moviesRoots: [path.join(tmp, 'Movies')], showsRoots: [path.join(tmp, 'Shows')], animeRoots: [path.join(tmp, 'Anime')] });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('reading folder names', () => {
  it('understands the common layouts', () => {
    expect(parseFolderName('Dune (2021)')).toEqual({ title: 'Dune', year: 2021 });
    expect(parseFolderName('Dune.2021.1080p.BluRay.x264-GRP')).toMatchObject({ title: 'Dune', year: 2021 });
    expect(parseFolderName('Frieren')).toEqual({ title: 'Frieren', year: null });
    expect(parseFolderName('Inception (2010) [tmdbid-27205]')).toEqual({ title: 'Inception', year: 2010, tmdbId: 27205 });
    expect(parseFolderName('Sousou no Frieren {anilist-154587}')).toEqual({ title: 'Sousou no Frieren', year: null, anilistId: 154587 });
    expect(parseFolderName('Severance (2022) [imdbid-tt11280740]')).toEqual({ title: 'Severance', year: 2022 });
  });
});

describe('deciding which title a folder is', () => {
  const r = (title: string, year: number | null, altTitles?: string[], id = 1) => ({ type: 'anime' as const, anilistId: id, title, year, poster: null, overview: '', altTitles });

  it('matches by name (any of its names) and year', () => {
    const frieren = r("Frieren: Beyond Journey's End", 2023, ['Sousou no Frieren', '葬送のフリーレン']);
    expect(pickMatch({ title: 'Sousou no Frieren', year: null }, [frieren])).toBe(frieren);
    expect(pickMatch({ title: 'Frieren Beyond Journeys End', year: 2023 }, [frieren])).toBe(frieren);
  });

  it('leaves it to you when unsure', () => {
    // Wrong year.
    expect(pickMatch({ title: 'Dune', year: 1984 }, [r('Dune', 2021)])).toBeNull();
    // Same name, different years, and no year to tell them apart.
    expect(pickMatch({ title: 'Dune', year: null }, [r('Dune', 2021, [], 1), r('Dune', 1984, [], 2)])).toBeNull();
    // Only a partial name match.
    expect(pickMatch({ title: 'Dune', year: 2021 }, [r('Dune: Part Two', 2024)])).toBeNull();
  });

  it('never mixes up a numbered sequel with the original', () => {
    const one = r('Cyberpunk: Edgerunners', 2022, ['Cyberpunk: Edgerunners'], 1);
    const two = r('Cyberpunk: Edgerunners 2', 2026, ['Cyberpunk: Edgerunners 2'], 2);
    const both = [one, two];
    for (const name of ['Cyberpunk - Edgerunners 2', 'Cyberpunk Edgerunners 2', 'Cyberpunk.Edgerunners.2.1080p.WEB', '[SubsPlease] Cyberpunk Edgerunners 2 (1080p)']) {
      expect(pickMatch(parseFolderName(name), both, true), name).toBe(two);
      expect(pickMatch(parseFolderName(name), [one], true), name).toBeNull();
    }
    // "S02" / "Season 2" folders of anime are the separate sequel entry.
    expect(pickMatch(parseFolderName('Cyberpunk Edgerunners S02'), both, true)).toBe(two);
    expect(pickMatch(parseFolderName('Cyberpunk Edgerunners Season 2'), [one], true)).toBeNull();
    // The original stays the original.
    expect(pickMatch(parseFolderName('Cyberpunk - Edgerunners'), both, true)).toBe(one);
    // Sequel spellings agree: "2nd Season", "II".
    const frieren2 = r('Sousou no Frieren 2nd Season', 2026, [], 3);
    expect(pickMatch(parseFolderName('Sousou no Frieren 2'), [r('Sousou no Frieren', 2023, [], 4), frieren2], true)).toBe(frieren2);
    // Movies too, and a show's "S02" folder is still that show (TMDB keeps seasons inside the show).
    expect(parseFolderName('Toy Story 2')).toEqual({ title: 'Toy Story 2', year: null });
    expect(pickMatch(parseFolderName('Toy Story 2'), [r('Toy Story', 1995, [], 5), r('Toy Story 2', 1999, [], 6)])?.anilistId).toBe(6);
    expect(pickMatch(parseFolderName('Severance S02'), [r('Severance', 2022)])?.title).toBe('Severance');
    // Numbers that are part of the name aren't sequels.
    expect(pickMatch(parseFolderName('Mob Psycho 100'), [r('Mob Psycho 100', 2016)], true)?.title).toBe('Mob Psycho 100');
  });
});

describe('scanning the library folders', () => {
  it('adds what it can identify, links files, and touches nothing on disk', async () => {
    const dune = path.join(tmp, 'Movies', 'Dune (2021)');
    touch(path.join(dune, 'Dune.2021.1080p.mkv'), 5000);
    touch(path.join(dune, 'Sample', 'sample.mkv'), 100);
    touch(path.join(tmp, 'Movies', 'Inception (2010) [tmdbid-27205]', 'movie.mp4'), 3000);
    touch(path.join(tmp, 'Movies', 'Home Videos', 'birthday.mp4'), 3000);
    fs.mkdirSync(path.join(tmp, 'Movies', 'Empty Folder'));
    const sev = path.join(tmp, 'Shows', 'Severance (2022)');
    touch(path.join(sev, 'Season 01', 'Severance.S01E01.1080p.mkv'));
    touch(path.join(sev, 'Severance - S01E02 - Good News About Hell.mkv'));
    touch(path.join(sev, 'Extras', 'Behind the Scenes.mkv'));

    const s = await scanLibrary({ delayMs: 0 });
    expect(s.added.map((a) => a.title).sort()).toEqual(['Dune', 'Inception', 'Severance']);
    expect(s.unmatched.map((u) => u.folder)).toEqual(['Home Videos']); // couldn't tell; the empty folder is ignored

    const movie = db.prepare("SELECT * FROM media WHERE title = 'Dune'").get() as { file_path: string; root_folder: string; folder_name: string; monitored: number };
    expect(movie).toMatchObject({ file_path: path.join(dune, 'Dune.2021.1080p.mkv'), folder_name: 'Dune (2021)', monitored: 0 });
    const show = db.prepare("SELECT id FROM media WHERE title = 'Severance'").get() as { id: number };
    const eps = getEpisodes(show.id);
    expect(eps.filter((e) => e.has_file).map((e) => e.episode)).toEqual([1, 2]);
    expect(eps.every((e) => !e.monitored)).toBe(true); // found, not requested: nothing gets downloaded
    // Files are where they were.
    expect(fs.existsSync(path.join(sev, 'Season 01', 'Severance.S01E01.1080p.mkv'))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM downloads').get()).toEqual({ n: 0 });
  });

  it('picks up files added by hand and forgets deleted ones on the next scan', async () => {
    const sev = path.join(tmp, 'Shows', 'Severance (2022)');
    touch(path.join(sev, 'S01E01.mkv'));
    touch(path.join(sev, 'S01E02.mkv'));
    await scanLibrary({ delayMs: 0 });
    fs.rmSync(path.join(sev, 'S01E01.mkv'));
    touch(path.join(sev, 'Severance S01E03.mkv'));
    const s = await scanLibrary({ delayMs: 0 });
    expect(s).toMatchObject({ added: [], linked: 1, missing: 1 });
    const show = db.prepare("SELECT id FROM media WHERE title = 'Severance'").get() as { id: number };
    expect(getEpisodes(show.id).filter((e) => e.has_file).map((e) => e.episode)).toEqual([2, 3]);
  });

  it('leaves titles alone when their library folder is unplugged', async () => {
    touch(path.join(tmp, 'Movies', 'Dune (2021)', 'dune.mkv'));
    await scanLibrary({ delayMs: 0 });
    fs.renameSync(path.join(tmp, 'Movies'), path.join(tmp, 'Movies-unplugged'));
    const s = await scanLibrary({ delayMs: 0 });
    expect(s.missing).toBe(0);
    expect((db.prepare("SELECT has_file FROM media WHERE title = 'Dune'").get() as { has_file: number }).has_file).toBe(1);
  });

  it('lets you identify a folder by hand', async () => {
    touch(path.join(tmp, 'Movies', 'Home Videos', 'film.mkv'));
    const s = await scanLibrary({ delayMs: 0 });
    expect(s.unmatched).toHaveLength(1);
    const m = await identifyFolder('movie', path.join(tmp, 'Movies'), 'Home Videos', { tmdbId: 603 });
    expect(m).toMatchObject({ title: 'The Matrix', folder_name: 'Home Videos', has_file: 1 });
    expect(s.unmatched).toHaveLength(0);
  });

  it('only adds folders that are directly inside a library folder', async () => {
    touch(path.join(tmp, 'Elsewhere', 'x.mkv'));
    await expect(addFolder('movie', path.join(tmp, 'Movies'), '../Elsewhere', { tmdbId: 603 })).rejects.toThrow(/isn’t one of the library folders/);
    await expect(addFolder('movie', path.join(tmp, 'Elsewhere'), '.', { tmdbId: 603 })).rejects.toThrow(/isn’t one of the library folders/);
  });

  it('links a single-file title even without an episode number', async () => {
    const id = Number(
      db.prepare(`INSERT INTO media (type, anilist_id, title, year, root_folder, folder_name, added_at) VALUES ('anime', 1, 'Your Name', 2016, ?, 'Your Name', datetime())`)
        .run(path.join(tmp, 'Anime')).lastInsertRowid,
    );
    db.prepare('INSERT INTO episodes (media_id, season, episode, monitored) VALUES (?, 1, 1, 0)').run(id);
    touch(path.join(tmp, 'Anime', 'Your Name', 'Kimi no Na wa (2016) [BD 1080p].mkv'));
    expect(await linkFiles(getMedia(id)!)).toBe(1);
  });
});
