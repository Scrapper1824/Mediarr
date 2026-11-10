const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Makes a string safe to use as a single Windows path segment. */
export function sanitize(name: string): string {
  let s = name
    .replace(/:\s/g, ' - ')
    .replace(/:/g, '-')
    .replace(/[<>"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (RESERVED.test(s)) s += '_';
  return s || 'Unknown';
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function folderName(type: 'movie' | 'show' | 'anime', title: string, year: number | null): string {
  if (type === 'anime' || !year) return sanitize(title);
  return sanitize(`${title} (${year})`);
}

export function movieFileName(folder: string, resolution: string | null, ext: string): string {
  return `${folder}${resolution ? ` [${resolution}]` : ''}${ext}`;
}

export function seasonFolder(season: number): string {
  return season === 0 ? 'Specials' : `Season ${pad(season)}`;
}

export function episodeFileName(
  showTitle: string,
  season: number,
  episodes: number[],
  episodeTitle: string | null,
  ext: string,
): string {
  const eps = episodes.length > 1 ? `E${pad(episodes[0])}-E${pad(episodes[episodes.length - 1])}` : `E${pad(episodes[0])}`;
  const epTitle = episodeTitle && episodes.length === 1 ? ` - ${episodeTitle.slice(0, 80)}` : '';
  return sanitize(`${showTitle} - S${pad(season)}${eps}${epTitle}`) + ext;
}

