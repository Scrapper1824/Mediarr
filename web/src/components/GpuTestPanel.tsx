import { useMutation } from '@tanstack/react-query';
import { api } from '../api';

interface GpuTestResult {
  testedAt: string;
  session: { name: string; id: number; state: string } | null;
  encoders: { encoder: string; label: string; works: boolean; error: string | null }[];
  using: string;
  usingLabel: string;
  wasFallingBack: boolean;
  verdict: 'gpu' | 'cpu-only' | 'gpu-off';
  advice: string;
}

const sessionText = (s: NonNullable<GpuTestResult['session']>) => {
  const disc = /^disc/i.test(s.state);
  if (/^console$/i.test(s.name)) return { text: 'On the server’s own screen (console)', good: true };
  if (disc) return { text: 'Disconnected Remote Desktop session', good: false };
  if (/^rdp/i.test(s.name)) return { text: `Remote Desktop, connected (${s.name})`, good: true };
  return { text: `${s.name || 'Unnamed session'} (${s.state})`, good: !disc };
};

/** Settings → Playback: check whether the graphics card works right now (e.g. after closing Remote Desktop with tscon). */
export default function GpuTestPanel() {
  const test = useMutation({ mutationFn: () => api.post<GpuTestResult>('/api/system/gpu-test') });
  const r = test.data;
  const session = r?.session ? sessionText(r.session) : null;

  return (
    <section className="panel">
      <h3>Test graphics card</h3>
      <p className="muted small">
        Tries a real conversion on the graphics card right now. On a server: instead of closing Remote Desktop, run{' '}
        <code>tscon %sessionname% /dest:console</code> as administrator, then press Test from your phone or another PC.
      </p>
      <div className="row">
        <button type="button" className="btn small" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? 'Testing…' : 'Test graphics card'}
        </button>
        {r && <span className="muted small">Tested {new Date(r.testedAt).toLocaleTimeString()}</span>}
      </div>
      {test.error && <div className="error-box">{(test.error as Error).message}</div>}
      {r && (
        <div className="gpu-test">
          <div className={`gpu-verdict ${r.verdict === 'gpu' ? 'ok' : 'bad'}`}>
            <strong>{r.verdict === 'gpu' ? '✓ Graphics card works' : r.verdict === 'gpu-off' ? 'Graphics card works, but it’s turned off' : '✕ Graphics card isn’t usable'}</strong>
            <span>{r.advice}</span>
            {r.wasFallingBack && r.verdict === 'gpu' && <span className="small">Videos had switched to the CPU after an earlier failure; they use the graphics card again now.</span>}
          </div>
          <dl className="gpu-facts">
            {session && (
              <div className="gpu-fact">
                <dt>Windows session</dt>
                <dd className={session.good ? 'ok-text' : 'error-text'}>{session.text}</dd>
              </div>
            )}
            <div className="gpu-fact">
              <dt>Videos convert with</dt>
              <dd>{r.usingLabel}</dd>
            </div>
            {r.encoders.map((e) => (
              <div key={e.encoder} className="gpu-fact">
                <dt>{e.label}</dt>
                <dd className={e.works ? 'ok-text' : 'muted'} title={e.error ?? undefined}>
                  {e.works ? '✓ works' : r.verdict === 'gpu' ? '✕ not available' : `✕ ${e.error ?? 'not available'}`}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}
