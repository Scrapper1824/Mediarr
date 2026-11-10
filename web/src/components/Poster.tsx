export default function Poster({ src, title, children }: { src: string | null; title: string; children?: React.ReactNode }) {
  return (
    <div className="poster">
      {src ? <img src={src} alt={title} loading="lazy" /> : <div className="poster-fallback">{title.slice(0, 1)}</div>}
      {children}
    </div>
  );
}
