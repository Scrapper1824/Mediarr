/** A small tomato (Rotten Tomatoes badge): red fruit, highlight, green leafy top. */
export default function TomatoIcon({ size = 22 }: { size?: number }) {
  return (
    <svg className="rt-icon" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <radialGradient id="rt-fruit" cx="38%" cy="38%" r="70%">
          <stop offset="0%" stopColor="#ff7a5c" />
          <stop offset="55%" stopColor="#fa320a" />
          <stop offset="100%" stopColor="#c21f00" />
        </radialGradient>
      </defs>
      {/* Fruit: slightly wider than tall, like a real tomato */}
      <ellipse cx="16" cy="18.5" rx="13" ry="11.5" fill="url(#rt-fruit)" />
      {/* Shine */}
      <ellipse cx="11" cy="14.5" rx="3.6" ry="2.2" fill="#fff" opacity="0.35" transform="rotate(-25 11 14.5)" />
      {/* Leafy calyx */}
      <path
        d="M16 9.5 L13 5.5 L15.4 8.2 L11 6.6 L14.6 9.6 L9.8 10.4 L14.9 10.9 L12.6 13.4 L16 11.4 L19.4 13.4 L17.1 10.9 L22.2 10.4 L17.4 9.6 L21 6.6 L16.6 8.2 L19 5.5 Z"
        fill="#00912d"
        stroke="#00912d"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      {/* Stem */}
      <path d="M16 9.8 C16 7.6 16.6 5.6 18.2 4" stroke="#00782a" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}
