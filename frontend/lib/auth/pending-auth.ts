/**
 * Hand-off for the two short-lived, single-use tokens POST /auth/login can
 * return instead of a session (api-contract.md §1): `mfaChallengeToken` and
 * `passwordChangeToken`. Both live 10 minutes and are only good for their
 * one follow-up call, so sessionStorage (per-tab, cleared on tab close) is
 * enough — it just lets the follow-up screen survive a reload.
 *
 * We record our own expiry so a stale token bounces straight back to Log In
 * with an explanation instead of failing on submit.
 */

const KEY = 'bwp.pendingAuth';
const TTL_MS = 10 * 60 * 1000;

export type PendingAuthKind = 'mfa' | 'password-change';

interface PendingAuth {
  kind: PendingAuthKind;
  token: string;
  email: string;
  expiresAt: number;
  /** Where to go after the follow-up step succeeds. */
  next?: string;
}

export function savePendingAuth(kind: PendingAuthKind, token: string, email: string, next?: string): void {
  try {
    const value: PendingAuth = { kind, token, email, next, expiresAt: Date.now() + TTL_MS };
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode quirks) — the follow-up screen will
    // treat this as expired and send the user back to Log In.
  }
}

export function readPendingAuth(kind: PendingAuthKind): PendingAuth | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as PendingAuth;
    if (value.kind !== kind || value.expiresAt <= Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}

export function clearPendingAuth(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
