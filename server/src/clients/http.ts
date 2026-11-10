export class HttpError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new HttpError(`Could not reach ${new URL(url).origin}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(`${res.status} ${res.statusText} from ${new URL(url).origin}${body ? `: ${body.slice(0, 200)}` : ''}`, res.status);
  }
  return (await res.json()) as T;
}

export const trimSlash = (u: string) => u.replace(/\/+$/, '');
