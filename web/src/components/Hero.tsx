import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SearchResult } from '../api';
import Chevron from './Chevron';
import Icon from './Icon';

export interface FeaturedItem extends SearchResult {
  backdrop: string | null;
  logo: string | null;
  rating: number | null;
  genres: string[];
  facts: string[];
  certification: string | null;
}

const ROTATE_MS = 9000;

function Logo({ item }: { item: FeaturedItem }) {
  const [failed, setFailed] = useState(false);
  if (item.logo && !failed) {
    return <img className="hero-logo" src={item.logo} alt={item.title} onError={() => setFailed(true)} />;
  }
  return <h2 className="hero-title">{item.title}</h2>;
}

/**
 * Jellyfin-style featured banner: full-width backdrop, title logo, meta line, description,
 * a big action button, dots and arrows. Rotates on its own unless you're hovering or using it.
 */
export default function Hero({
  items,
  onRequest,
  top,
  loading = false,
  onInfo,
}: {
  items: FeaturedItem[];
  onRequest: (item: FeaturedItem) => void;
  /** Overlaid at the top of the banner (the tab switcher and search). */
  top?: React.ReactNode;
  /** While the titles load, keep the banner's shape (no layout jump when switching tabs). */
  loading?: boolean;
  /** The "i" button: show the details sheet. */
  onInfo?: (item: FeaturedItem) => void;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  // Backdrops fade in once downloaded instead of popping in over black.
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  const count = items.length;
  const go = useCallback((i: number) => setIndex(((i % count) + count) % count), [count]);

  useEffect(() => setIndex(0), [items]);
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (paused || reduced || count < 2) return;
    const t = setTimeout(() => go(index + 1), ROTATE_MS);
    return () => clearTimeout(t);
  }, [index, paused, count, go]);

  if (!count) {
    if (!loading) return null;
    return (
      <section className="featured-banner is-loading" aria-label="Featured" aria-busy>
        <div className="hero-shade" />
        {top && <div className="hero-top">{top}</div>}
        <div className="hero-content">
          <div className="skeleton hero-skel hero-skel-title" />
          <div className="skeleton hero-skel hero-skel-line" />
          <div className="skeleton hero-skel hero-skel-text" />
          <div className="skeleton hero-skel hero-skel-text short" />
          <div className="skeleton hero-skel hero-skel-button" />
        </div>
      </section>
    );
  }
  // Guard against a slide number left over from a longer list.
  const item = items[index % count];
  const meta = [
    item.year ? String(item.year) : null,
    item.rating ? `★ ${item.rating.toFixed(1)}` : null,
    ...item.facts,
    item.genres.length ? item.genres.join(' · ') : null,
  ].filter(Boolean) as string[];

  return (
    <section
      className={`featured-banner${item.type === 'anime' && item.poster ? ' has-poster' : ''}`}
      aria-roledescription="carousel"
      aria-label="Featured"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {items.map((it, i) => (
        <div
          key={`${it.type}-${it.tmdbId ?? it.anilistId}`}
          className={`hero-slide${i === index ? ' active' : ''}${it.type === 'anime' ? ' soft' : ''}`}
          aria-hidden={i !== index}
        >
          {it.backdrop && (
            <img
              className="hero-backdrop"
              src={it.backdrop}
              alt=""
              // The visible slide and the next one load right away; the rest when needed.
              loading={i === index || i === (index + 1) % count ? 'eager' : 'lazy'}
              decoding="async"
              data-loaded={loaded.has(it.backdrop) || undefined}
              onLoad={() => setLoaded((prev) => new Set(prev).add(it.backdrop!))}
            />
          )}
        </div>
      ))}
      <div className="hero-shade" />
      {item.type === 'anime' && item.poster && <img key={`poster-${index}`} className="hero-poster" src={item.poster} alt="" />}

      {top && <div className="hero-top">{top}</div>}

      <div className="hero-content" key={index}>
        <Logo item={item} />
        <div className="hero-rule" />
        <div className="hero-meta">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
          {item.certification && <span className="hero-cert">{item.certification}</span>}
        </div>
        {item.overview && <p className="hero-overview">{item.overview}</p>}
        <div className="hero-actions">
          {item.libraryId ? (
            <Link className="hero-play" to={`/media/${item.libraryId}`}>
              <span aria-hidden>▶</span> Open
            </Link>
          ) : (
            <button className="hero-play" onClick={() => onRequest(item)}>
              <span aria-hidden>＋</span> Request
            </button>
          )}
          {item.libraryId ? (
            <span className="hero-badge">In library</span>
          ) : (
            <button className="hero-round" title="More info" aria-label={`More about ${item.title}`} onClick={() => (onInfo ?? onRequest)(item)}>
              <Icon name="infoMark" size={24} />
            </button>
          )}
        </div>
        {count > 1 && (
          <div className="hero-dots" role="tablist" aria-label="Choose featured title">
            {items.map((it, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === index}
                aria-label={it.title}
                className={i === index ? 'on' : ''}
                onClick={() => go(i)}
              />
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
