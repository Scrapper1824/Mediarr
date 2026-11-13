import { useQuery } from '@tanstack/react-query';
import { api, watchId, type MediaType, type WatchItem, type WatchLinks, type WatchStatus } from './api';

/** A title's place on your watchlists; `undefined` when no connected list takes this kind of title. */
export type WatchTag = { status: WatchStatus | null } | undefined;

/**
 * Your watchlist status for titles, for the tags on posters (Home and Discover). Anime goes to AniList or
 * Simkl, movies and shows to Simkl; with neither connected there's no tag. Every card shares one fetch.
 */
export function useWatchTags() {
  const links = useQuery({ queryKey: ['watchlist', 'links'], queryFn: () => api.get<WatchLinks>('/api/watchlist/links'), staleTime: 5 * 60_000 });
  const simkl = !!links.data?.simkl.connected;
  const anilist = !!links.data?.anilist.connected;
  const list = useQuery({
    queryKey: ['watchlist', 'items'],
    queryFn: () => api.get<{ items: WatchItem[]; errors: string[] }>('/api/watchlist'),
    enabled: simkl || anilist,
    staleTime: 60_000,
  });
  const items = list.data?.items ?? [];
  return (t: { type: MediaType; tmdbId?: number; anilistId?: number; libraryId?: number | null }): WatchTag => {
    const takes = (type: MediaType) => (type === 'anime' ? simkl || anilist : simkl);
    if (!takes(t.type) || !list.data) return undefined;
    const id = watchId(t);
    const hit = (t.libraryId ? items.find((i) => i.libraryId === t.libraryId) : undefined) ?? (id ? items.find((i) => i.key === `${t.type}:${id}`) : undefined);
    return { status: hit?.status ?? null };
  };
}
