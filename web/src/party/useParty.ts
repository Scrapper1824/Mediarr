// The watch-party connection: the party's details (REST), then its sync socket (state pushes, clock pings, commands).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type PartyInfo, type PartyMember, type PartyPlayState, type PartyTitle } from '../api';
import { Clock } from './sync';
import { backoffMs, closeOutcome, parseServerMessage, pingDelayMs, type ClientCommand } from './protocol';

export type PartyStatus = 'connecting' | 'live' | 'ended' | 'replaced' | 'error';

export interface PartyConnection {
  /** From GET /api/party/:id (loaded once). */
  party: PartyInfo | null;
  /** The latest state pushed over the socket; null until the first push. */
  state: PartyPlayState | null;
  title: PartyTitle | null;
  members: PartyMember[];
  waitingFor: string[];
  /** Sends a command if the socket is open; false when it couldn't be sent. */
  send(cmd: ClientCommand): boolean;
  status: PartyStatus;
  /** Why, when status is 'error'. */
  error: string | null;
  /** The clock has at least one server time sample. */
  synced: boolean;
  clock: Clock;
  /** Goes up by one on every socket (re)connect. */
  connection: number;
}

/** What the player needs from the party (see Player's `party` prop). */
export interface PartyBinding {
  send(cmd: ClientCommand): boolean;
  state: PartyPlayState | null;
  title: PartyTitle | null;
  members: PartyMember[];
  waitingFor: string[];
  clock: Clock;
  guest: boolean;
  isHost: boolean;
  status: PartyStatus;
  connection: number;
  onLeave(): void;
  onEnd(): void;
}

interface Live {
  state: PartyPlayState;
  title: PartyTitle;
  members: PartyMember[];
  waitingFor: string[];
}

export function useParty(partyId: string): PartyConnection {
  const [clock] = useState(() => new Clock());
  const [party, setParty] = useState<PartyInfo | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [status, setStatus] = useState<PartyStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);
  const [connection, setConnection] = useState(0);
  const sockRef = useRef<WebSocket | null>(null);

  const send = useCallback((cmd: ClientCommand) => {
    const s = sockRef.current;
    if (!s || s.readyState !== WebSocket.OPEN) return false;
    s.send(JSON.stringify(cmd));
    return true;
  }, []);

  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let openedAt = 0;
    let retryTimer: number | undefined;
    let pingTimer: number | undefined;
    setParty(null);
    setLive(null);
    setStatus('connecting');
    setError(null);
    setSynced(false);

    const stop = () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(pingTimer);
      if (ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
      }
      ws = null;
      sockRef.current = null;
    };
    /** No more reconnecting: the party is over for this page. */
    const finish = (s: PartyStatus, message: string | null = null) => {
      if (stopped) return;
      stop();
      setStatus(s);
      setError(message);
    };

    /** 'ok', 'gone' (ended, or no longer ours to see) or 'failed' (couldn't ask: network, server error). */
    const load = async (): Promise<{ r: 'ok' | 'gone' | 'failed'; message?: string }> => {
      try {
        const p = await api.get<PartyInfo>(`/api/party/${encodeURIComponent(partyId)}`);
        if (stopped) return { r: 'failed' };
        setParty(p);
        return { r: p.ended ? 'gone' : 'ok' };
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 401)) return { r: 'gone' };
        return { r: 'failed', message: (e as Error).message };
      }
    };

    const ping = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ t: 'ping', c: Date.now() }));
      pingTimer = window.setTimeout(ping, pingDelayMs(Date.now() - openedAt));
    };

    const connect = () => {
      if (stopped) return;
      setStatus('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(`${proto}//${window.location.host}/api/party/${encodeURIComponent(partyId)}/socket`);
      ws = sock;
      sockRef.current = sock;
      let opened = false;
      sock.onopen = () => {
        if (stopped || ws !== sock) return;
        opened = true;
        attempt = 0;
        openedAt = Date.now();
        setStatus('live');
        setConnection((n) => n + 1);
        ping();
      };
      sock.onmessage = (e) => {
        if (stopped || ws !== sock) return;
        const m = parseServerMessage(e.data);
        if (!m) return;
        switch (m.t) {
          case 'pong':
            clock.sample(m.c, m.s, Date.now());
            setSynced(true);
            if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'rtt', ms: Math.round(clock.rtt()) }));
            return;
          case 'state':
            setLive({ state: m.state, title: m.title, members: m.members, waitingFor: m.waitingFor });
            return;
          case 'ended':
            finish('ended');
            return;
          case 'replaced':
            finish('replaced');
            return;
        }
      };
      sock.onclose = (e) => {
        if (stopped || ws !== sock) return;
        window.clearTimeout(pingTimer);
        ws = null;
        sockRef.current = null;
        const outcome = closeOutcome(e.code, e.reason);
        if (outcome === 'ended') return finish('ended');
        if (outcome === 'replaced') return finish('replaced');
        if (outcome === 'left') return finish('error', 'You left the watch party.');
        setStatus('connecting');
        retryTimer = window.setTimeout(async () => {
          // Never got in: the party may have ended (or we were removed) while we were away.
          if (!opened) {
            const { r } = await load();
            if (stopped) return;
            if (r === 'gone') return finish('ended');
          }
          connect();
        }, backoffMs(attempt++));
      };
    };

    (async () => {
      const { r, message } = await load();
      if (stopped) return;
      if (r === 'gone') return finish('ended');
      if (r === 'failed') return finish('error', message ?? 'Couldn’t reach the server.');
      connect();
    })();

    return stop;
  }, [partyId, clock]);

  return {
    party,
    state: live?.state ?? null,
    title: live?.title ?? party?.title ?? null,
    members: live?.members ?? party?.members ?? [],
    waitingFor: live?.waitingFor ?? [],
    send,
    status,
    error,
    synced,
    clock,
    connection,
  };
}
