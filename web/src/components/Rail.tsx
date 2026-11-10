import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Chevron from './Chevron';

/**
 * A streaming-style row: a heading, an optional "See all", and cards that scroll sideways edge to edge,
 * with arrows that appear on hover (swipe on touch screens).
 */
export default function Rail({
  title,
  seeAll,
  wide = false,
  children,
}: {
  title: string;
  /** Where "See all" goes. */
  seeAll?: string;
  /** 16:9 cards (Continue watching) instead of posters. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  return (
    <section className="home-rail" aria-label={title}>
      <header className="home-rail-head">
        <h2>{title}</h2>
        {seeAll && (
          <Link className="home-see-all" to={seeAll}>
            See all <Chevron dir="right" size={13} />
          </Link>
        )}
      </header>
      <div className="home-rail-viewport">
        <button type="button" className="home-arrow left" aria-label={`Scroll ${title} left`} disabled={edges.start} onClick={() => page(-1)} tabIndex={-1}>
          <Chevron dir="left" size={22} />
        </button>
        <div className={`home-scroller${wide ? ' wide' : ''}`} ref={scroller} onScroll={measure}>
          {children}
        </div>
        <button type="button" className="home-arrow right" aria-label={`Scroll ${title} right`} disabled={edges.end} onClick={() => page(1)} tabIndex={-1}>
          <Chevron dir="right" size={22} />
        </button>
      </div>
    </section>
  );
}

/** Placeholder row while the page loads. */
export function RailSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <section className="home-rail" aria-hidden>
      <header className="home-rail-head">
        <div className="skeleton skeleton-title" />
      </header>
      <div className="home-rail-viewport">
        <div className={`home-scroller${wide ? ' wide' : ''}`}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className={`skeleton home-skel-card${wide ? ' wide' : ''}`} />
          ))}
        </div>
      </div>
    </section>
  );
}
