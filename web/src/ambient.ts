import { useEffect } from 'react';

/**
 * The page glow: the most characteristic colour of the artwork on screen becomes `--ambient` on the page,
 * which the background (and a few accents) blend in softly. Falls back to the default blue when the
 * image can't be read.
 */

const cache = new Map<string, string | null>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** A colour that reads as the image's mood: saturated pixels count most, near-black/white barely at all. */
export function moodColour(data: Uint8ClampedArray): string | null {
  // Hue buckets weighted by colourfulness; the strongest bucket wins, averaged within itself.
  const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    const [h, s, l] = rgbToHsl(r, g, b);
    const w = s * (1 - Math.abs(l - 0.5) * 1.8);
    if (w <= 0.05) continue;
    const bk = buckets[Math.floor(h / 30) % 12];
    bk.w += w;
    bk.r += r * w;
    bk.g += g * w;
    bk.b += b * w;
  }
  const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
  if (best.w < 1) return null;
  const [h, s, l] = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
  // Calm it down to a glow: never neon, never muddy.
  const ss = Math.round(Math.min(0.72, Math.max(0.4, s)) * 100);
  const ll = Math.round(Math.min(0.6, Math.max(0.45, l)) * 100);
  return `hsl(${Math.round(h)} ${ss}% ${ll}%)`;
}

function readColour(src: string): Promise<string | null> {
  if (cache.has(src)) return Promise.resolve(cache.get(src)!);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 24;
        c.height = 36;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const colour = moodColour(ctx.getImageData(0, 0, c.width, c.height).data);
        cache.set(src, colour);
        resolve(colour);
      } catch {
        cache.set(src, null); // the host doesn't allow reading it
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    // Its own URL: the page's <img> may have cached this picture without the CORS header that reading it needs.
    img.src = src + (src.includes('?') ? '&' : '?') + 'ambient=1';
  });
}

/** Tints the page with this artwork's colour while the component is on screen. */
export function useAmbient(src: string | null | undefined) {
  useEffect(() => {
    if (!src) return;
    let alive = true;
    void readColour(src).then((colour) => {
      if (alive && colour) document.documentElement.style.setProperty('--ambient', colour);
    });
    return () => {
      alive = false;
      document.documentElement.style.removeProperty('--ambient');
    };
  }, [src]);
}
