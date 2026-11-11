import type { MediaType } from './api';

/** Shapes and helpers for the Home page (server: core/home.ts). */

/** A downloaded title, as the server's /api/home sends it. */
export interface HomeTitle {
  mediaId: number;
  type: MediaType;
  title: string;
  year: number | null;
  poster: string | null;
  backdrop: string | null;
  overview: string;
  tmdbId?: number;
  anilistId?: number;
  addedAt: string;
  episodeFiles: number;
}
export interface PlayTarget {
  kind: 'movie' | 'episode';
  id: number;
  label: string | null;
  episodeTitle: string | null;
  resume: boolean;
  position: number;
  duration: number;
  minutesLeft: number | null;
}
export interface HomeFeatured extends HomeTitle {
  play: PlayTarget;
  reason: 'continue' | 'upnext' | 'new';
}
/** A poster on Home: what clicking it plays (null if nothing can be played). */
export interface PlayableTitle extends HomeTitle {
  play: PlayTarget | null;
}
export interface ContinueItem extends HomeTitle, PlayTarget {
  upNext: boolean;
  updatedAt: string;
}
export interface HomeData {
  featured: HomeFeatured[];
  continue: ContinueItem[];
  recent: PlayableTitle[];
  libraries: Record<MediaType, PlayableTitle[]>;
}

/** TMDB backdrops are stored at a size for cards; the full-width banner asks for the sharp one. */
export const sharp = (url: string) => url.replace('image.tmdb.org/t/p/w1280/', 'image.tmdb.org/t/p/original/');

/** "S1 E5" from "S01E05". */
export const shortEp = (label: string) => label.replace(/^S0?(\d+)E0?(\d+)$/, 'S$1 E$2');
