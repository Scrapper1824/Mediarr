import Icon from './Icon';

/** Plays a YouTube trailer (privacy-enhanced, no-cookie player) over the page. */
export default function TrailerPlayer({ youtubeId, title, onClose }: { youtubeId: string; title: string; onClose: () => void }) {
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeId)}?autoplay=1&rel=0&modestbranding=1`;
  return (
    <div className="trailer-backdrop" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="trailer-frame">
        <iframe
          src={src}
          title={title}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
        <button className="hero-round trailer-close" aria-label="Close trailer" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
    </div>
  );
}
