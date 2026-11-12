import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Chevron from './Chevron';
import Icon from './Icon';
import { useAmbient } from '../ambient';
import { shortEp, sharp, type HomeFeatured } from '../home';

const ROTATE_MS = 9000;
const TYPE_WORD = { movie: 'Movie', show: 'TV Show', anime: 'Anime' } as const;

/**
 * The Home banner: titles from your own library (what you're watching, then what's new), with one
 * big Play / Resume button. Same look as the Discover banner.
 */
export default function HomeHero({ items, loading }: { items: HomeFeatured[]; loading: boolean }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  const count = items.length;
  const go = useCallback((i: number) => setIndex(((i % count) + count) % count), [count]);
  // The page glows in the colours of the title on screen.
  useAmbient(count ? items[index % count].poster : null);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (paused || reduced || count < 2) return;
    const t = setTimeout(() => go(index + 1), ROTATE_MS);
    return () => clearTimeout(t);
  }, [index, paused, count, go]);

  if (!count) {
    if (loading) {
      return (
        <section className="featured-banner home-banner is-loading" aria-busy aria-label="Featured">
          <div className="hero-shade" />
          <div className="hero-content">
            <div className="skeleton hero-skel hero-skel-title" />
            <div className="skeleton hero-skel hero-skel-line" />
            <div className="skeleton hero-skel hero-skel-text" />
            <div className="skeleton hero-skel hero-skel-button" />
          </div>
        </section>
      );
    }
    return (
      <section className="featured-banner home-banner home-empty" aria-label="Nothing to watch yet">
        <div className="hero-shade" />
        <div className="hero-content">
          <h2 className="hero-title">Nothing to watch yet</h2>
          <p className="hero-overview">Request a movie, show or anime and it shows up here as soon as it’s downloaded.</p>
          <div className="hero-actions">
            <Link className="hero-play" to="/discover">
              Find something
            </Link>
          </div>
        </div>
      </section>
    );
  }

  const item = items[index % count];
  const art = (it: HomeFeatured) => (it.backdrop ? sharp(it.backdrop) : it.poster);
  const meta = [
    item.year ? String(item.year) : null,
    TYPE_WORD[item.type],
    item.type !== 'movie' && item.episodeFiles ? `${item.episodeFiles} episode${item.episodeFiles === 1 ? '' : 's'}` : null,
  ].filter(Boolean) as string[];
  const p = item.play;

  return (
    <section
      className={`featured-banner home-banner${!item.backdrop && item.poster ? ' has-poster' : ''}`}
      aria-roledescription="carousel"
      aria-label="Featured"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {items.map((it, i) => {
        const src = art(it);
        return (
          <div key={it.mediaId} className={`hero-slide${i === index ? ' active' : ''}${it.backdrop ? '' : ' soft'}`} aria-hidden={i !== index}>
            {src && (
              <img
                className="hero-backdrop"
                src={src}
                alt=""
                loading={i === index || i === (index + 1) % count ? 'eager' : 'lazy'}
                decoding="async"
                data-loaded={loaded.has(src) || undefined}
                onLoad={() => setLoaded((prev) => new Set(prev).add(src))}
              />
            )}
          </div>
        );
      })}
      <div className="hero-shade" />
      {!item.backdrop && item.poster && <img key={`poster-${index}`} className="hero-poster" src={item.poster} alt="" />}

      <div className="hero-content" key={index}>
        <div className="home-hero-kicker">{item.reason === 'continue' ? 'Continue watching' : item.reason === 'upnext' ? 'Up next' : 'New in your library'}</div>
        <h2 className="hero-title">{item.title}</h2>
        <div className="hero-rule" />
        <div className="hero-meta">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
        {p.label && (
          <div className="home-hero-episode">
            {p.label.replace(/^S0?(\d+)E0?(\d+)$/, 'Season $1 · Episode $2')}
            {p.episodeTitle && !/^Episode \d+$/i.test(p.episodeTitle) ? ` — ${p.episodeTitle}` : ''}
          </div>
        )}
        {item.overview && <p className="hero-overview">{item.overview}</p>}
        <div className="hero-actions">
          <Link className="hero-play" to={`/watch/${p.kind}/${p.id}`}>
            <span aria-hidden>▶</span> {p.resume ? 'Resume' : 'Play'}
            {p.label ? ` ${shortEp(p.label)}` : ''}
            {p.resume && p.minutesLeft ? <span className="hero-play-left">· {p.minutesLeft} min left</span> : null}
          </Link>
          <Link className="hero-round" to={`/media/${item.mediaId}`} title="More info" aria-label={`More about ${item.title}`}>
            <Icon name="infoMark" size={24} />
          </Link>
          {p.resume && p.duration > 0 && (
            <span className="home-hero-progress" aria-label={`${Math.round((p.position / p.duration) * 100)}% watched`}>
              <span style={{ width: `${Math.min(100, (p.position / p.duration) * 100)}%` }} />
            </span>
          )}
        </div>
        {count > 1 && (
          <div className="hero-dots" role="tablist" aria-label="Choose featured title">
            {items.map((it, i) => (
              <button key={it.mediaId} role="tab" aria-selected={i === index} aria-label={it.title} className={i === index ? 'on' : ''} onClick={() => go(i)} />
            ))}
          </div>
        )}
      </div>

      {count > 1 && (
        <div className="hero-arrows">
          <button className="hero-round" aria-label="Previous" onClick={() => go(index - 1)}>
            <Chevron dir="left" />
          </button>
          <button className="hero-round" aria-label="Next" onClick={() => go(index + 1)}>
            <Chevron dir="right" />
          </button>
        </div>
      )}
    </section>
  );
}
