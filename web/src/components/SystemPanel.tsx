import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface Autostart {
  supported: boolean;
  enabled: boolean;
}

/** Admin-only: start Mediarr (in the system tray) when you log in to Windows. */
export default function SystemPanel() {
  const qc = useQueryClient();
  const autostart = useQuery({ queryKey: ['autostart'], queryFn: () => api.get<Autostart>('/api/system/autostart') });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.put<Autostart>('/api/system/autostart', { enabled }),
    onSuccess: (data) => qc.setQueryData(['autostart'], data),
  });
  if (!autostart.data?.supported) return null;

  return (
    <section className="panel system-panel">
      <h2>System</h2>
      <label className="switch">
        <input
          type="checkbox"
          checked={autostart.data.enabled}
          disabled={toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        <span className="slider" />
        <span>Start Mediarr when I log in to Windows</span>
      </label>
      <p className="hint">
        Runs in the background with an icon in the system tray (bottom-right, near the clock). Right-click it to open, start, stop or
        restart Mediarr, reset a password, or quit. <code>npm start</code> starts it the same way.
      </p>
      {toggle.error && <div className="error-box">{(toggle.error as Error).message}</div>}
    </section>
  );
}
