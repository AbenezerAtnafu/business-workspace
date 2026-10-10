import { ApiError } from './errors';

/**
 * Thin fetch wrapper over the backend REST API (architecture/api-contract.md).
 *
 * Token model (§0):
 *  - The 15-minute access token lives ONLY in this module's memory — never
 *    localStorage/sessionStorage — so it isn't readable after a reload or
 *    by another tab, and is gone the moment the tab closes.
 *  - The 30-day refresh token is an httpOnly cookie the backend sets, scoped
 *    to `/api/v1/auth/refresh`. JS never sees it; we just call that path with
 *    `credentials: 'include'` and get a fresh access token back.
 *  - A 401 on an authenticated call triggers one refresh + one retry. If the
 *    refresh itself fails, the session is over: listeners are notified so the
 *    AuthProvider can drop the user back to Log In.
 *
 * The refresh cookie is SameSite=Strict, so the frontend and API must be
 * same-site (e.g. localhost:3001 ↔ localhost:3000 in dev; app.example.com ↔
 * api.example.com in prod). Cross-site deployments would never send it.
 */

const API_ORIGIN = (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
export const API_BASE = `${API_ORIGIN}/api/v1`;

let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;
const sessionExpiredListeners = new Set<() => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** Called when a refresh fails mid-session (refresh token expired/revoked). */
export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

/**
 * POST /auth/refresh. Single-flight: the backend ROTATES the refresh token on
 * every use, so two concurrent refreshes would race — the second presents an
 * already-rotated token and fails. Every caller (initial session restore,
 * parallel 401 retries, React StrictMode's double-mount) shares one promise.
 */
export function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
        if (!res.ok) {
          accessToken = null;
          return null;
        }
        const body = (await res.json()) as { accessToken: string };
        accessToken = body.accessToken;
        return accessToken;
      } catch {
        // Network failure: don't clear an existing token on a blip.
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Send the bearer token and auto-refresh on 401. Default true; false for public endpoints. */
  auth?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T = unknown>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  const { auth = true } = opts;
  let res = await send(path, opts, auth);

  if (auth && (await isTokenFailure(res))) {
    const fresh = await refreshAccessToken();
    if (fresh) {
      res = await send(path, opts, auth);
    }
    if (!fresh || (await isTokenFailure(res))) {
      accessToken = null;
      sessionExpiredListeners.forEach((l) => l());
    }
  }

  return parse<T>(res);
}

/**
 * A 401 means "your access token is missing/expired/invalid" only when its
 * code is UNAUTHENTICATED. Some authenticated endpoints also return 401 for a
 * wrong *credential in the body* — e.g. POST /me/mfa/disable with an
 * incorrect password → 401 INVALID_CREDENTIALS. Treating that as an expired
 * session would refresh, retry, fail again and log the user out for a typo.
 */
async function isTokenFailure(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  try {
    const body = (await res.clone().json()) as { error?: { code?: string } };
    return body?.error?.code !== 'INVALID_CREDENTIALS';
  } catch {
    return true;
  }
}

async function send(path: string, opts: ApiRequestOptions, auth: boolean): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  try {
    return await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      // Needed so Set-Cookie on login/signup/invite-accept responses is
      // honoured cross-origin (the refresh cookie is issued there).
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Network error' });
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  if (!res.ok) {
    const envelope = (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })
      ?.error;
    const retryAfterHeader = res.headers.get('Retry-After');
    throw new ApiError({
      status: res.status,
      code: envelope?.code ?? `HTTP_${res.status}`,
      message: envelope?.message ?? `Request failed (${res.status})`,
      details: envelope?.details,
      // The header is only readable cross-origin if the API exposes it (it
      // does since 2026-10-07); details.retryAfterSeconds is the same value
      // in the body, as a fallback.
      retryAfter:
        (retryAfterHeader ? Number(retryAfterHeader) || undefined : undefined) ??
        (typeof envelope?.details?.retryAfterSeconds === 'number' ? envelope.details.retryAfterSeconds : undefined),
    });
  }

  return body as T;
}

/**
 * Multipart upload with progress (webmail attachments). fetch() can't report
 * upload progress, so this uses XMLHttpRequest; same token handling as api():
 * one refresh + one retry on an expired token.
 */
export async function apiUpload<T = unknown>(
  path: string,
  file: File,
  opts: { field?: string; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<T> {
  const attempt = () =>
    new Promise<{ status: number; text: string; retryAfter: string | null }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}${path}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Accept', 'application/json');
      if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
      };
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText, retryAfter: xhr.getResponseHeader('Retry-After') });
      xhr.onerror = () => reject(new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Network error' }));
      xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
      opts.signal?.addEventListener('abort', () => xhr.abort());
      const form = new FormData();
      form.append(opts.field ?? 'file', file, file.name);
      xhr.send(form);
    });

  let res = await attempt();
  if (res.status === 401) {
    const fresh = await refreshAccessToken();
    if (fresh) res = await attempt();
    if (!fresh || res.status === 401) {
      accessToken = null;
      sessionExpiredListeners.forEach((l) => l());
    }
  }
  return parse<T>(new Response(res.text || null, { status: res.status, headers: res.retryAfter ? { 'Retry-After': res.retryAfter } : {} }));
}

/**
 * Authenticated binary download (webmail attachments): the bearer token lives
 * in memory, so a plain <a href> can't carry it. Returns the bytes and the
 * server's file name; the caller saves it.
 */
export async function apiDownload(path: string): Promise<{ blob: Blob; fileName: string | null }> {
  const go = () =>
    fetch(`${API_BASE}${path}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      credentials: 'include',
    }).catch(() => {
      throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Network error' });
    });
  let res = await go();
  if (res.status === 401 && (await refreshAccessToken())) res = await go();
  if (!res.ok) await parse(res); // throws the API's error
  const cd = res.headers.get('Content-Disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="([^"]+)"/i.exec(cd);
  return { blob: await res.blob(), fileName: star ? decodeURIComponent(star[1]) : plain ? plain[1] : null };
}
