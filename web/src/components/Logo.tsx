/** The Mediarr mark, drawn exactly like the browser-tab icon (index.html): a flat gold tile with a stroked M. */
export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#f5a524" />
      <path d="M8 23V9l8 8 8-8v14" stroke="#161616" strokeWidth="3.5" fill="none" strokeLinejoin="round" />
    </svg>
  );
}
