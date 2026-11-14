// Pure sync math for Watch Together: clock offset, expected position, drift correction.

type Sample = { offset: number; rtt: number };

export class Clock {
  private samples: Sample[] = [];

  sample(clientSent: number, serverTime: number, clientReceived: number): void {
    const rtt = Math.max(0, clientReceived - clientSent);
    const offset = serverTime - (clientSent + rtt / 2);
    this.samples.push({ offset, rtt });
    if (this.samples.length > 5) this.samples.shift();
  }

  private best(): Sample | null {
    let best: Sample | null = null;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best;
  }

  /** serverMs - clientMs, from the lowest-RTT of the last 5 samples. */
  offset(): number {
    return this.best()?.offset ?? 0;
  }

  rtt(): number {
    return this.best()?.rtt ?? 0;
  }

  now(): number {
    return Date.now() + this.offset();
  }
}

export type Correction =
  | { kind: 'none' }
  | { kind: 'rate'; rate: 0.95 | 1.05 }
  | { kind: 'reset-rate' }
  | { kind: 'jump'; to: number };

export function expectedPosition(
  state: { playing: boolean; position: number; at: number },
  serverNow: number,
): number {
  if (!state.playing) return state.position;
  return state.position + Math.max(0, serverNow - state.at) / 1000;
}

const IGNORE = 0.1;
const SETTLE = 0.05;
const JUMP = 1;
const EPS = 1e-9;

/** drift = currentTime - expected (positive = ahead). */
export function correction(currentTime: number, expected: number, currentRate: number): Correction {
  const drift = currentTime - expected;
  const abs = Math.abs(drift);
  if (abs > JUMP + EPS) return { kind: 'jump', to: expected };
  const correcting = currentRate !== 1;
  if (correcting) {
    if (abs <= SETTLE + EPS) return { kind: 'reset-rate' };
  } else if (abs < IGNORE - EPS) {
    return { kind: 'none' };
  }
  return { kind: 'rate', rate: drift > 0 ? 0.95 : 1.05 };
}

type Ev = { type: 'play' | 'pause' | 'seek'; position: number; atClient: number };

export function isEcho(lastApplied: Ev | null, event: Ev): boolean {
  if (!lastApplied) return false;
  return (
    lastApplied.type === event.type &&
    Math.abs(event.atClient - lastApplied.atClient) <= 400 &&
    Math.abs(event.position - lastApplied.position) <= 0.25
  );
}
