import { describe, expect, it } from 'vitest';
import { requestedMedia } from './library.js';

describe('adding a title from the web app', () => {
  it('never takes the folder (or who asked) from the client', () => {
    const body = { type: 'movie' as const, tmdbId: 5, monitored: true, location: { root: '/etc', folder: 'ssh' }, requestedBy: 'someone-else' };
    expect(requestedMedia(body)).toEqual({ type: 'movie', tmdbId: 5, monitored: true });
  });
});
