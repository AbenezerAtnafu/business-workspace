import { AppException } from '../errors/app-exception';

/**
 * Cursor pagination — architecture/api-contract.md §0:
 *
 *   ?limit=25&cursor=<opaque>   (max limit: 100)
 *   → { "data": [ ... ], "meta": { "nextCursor": "eyJpZCI6Ii4uLiJ9", "hasMore": true } }
 *
 * The cursor is base64url(JSON.stringify({ id })) — the id of the last row
 * on the previous page. That works because every table's primary key is a
 * UUIDv7 (migration 000/007), which is time-ordered: `ORDER BY id DESC` is
 * newest-first, and `WHERE id < :cursorId` continues from where the last
 * page stopped with no OFFSET scan and no duplicates or gaps when new rows
 * arrive between page loads.
 *
 * Intended for append-only, unbounded-growth lists (notifications, audit
 * logs). Small, bounded per-org lists (domains, org units, groups, users)
 * deliberately stay unpaginated.
 *
 * Usage: query `LIMIT limit + 1` rows, then hand them to buildPage(), which
 * uses the extra row only to decide `hasMore` and drops it from `data`.
 *
 * (Reconstructed 2026-10-07: the original Step 3.1 file never reached the
 * Mac copy of this repo; rebuilt to the same contract and call sites.)
 */

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?limit=` → 1..100, default 25. Anything non-integer or out of range is a 400, not a silent clamp. */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_PAGE_LIMIT;
  }
  if (!/^\d+$/.test(raw)) {
    throw new AppException(400, 'VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new AppException(400, 'VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  return limit;
}

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

/**
 * `?cursor=` → the row id to continue below, or null for the first page.
 * A garbled cursor 400s cleanly instead of reaching Postgres as an invalid
 * uuid literal (which would surface as a 500).
 */
export function decodeCursor(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  try {
    // Accept both base64url (what we emit) and plain base64.
    const json = Buffer.from(raw, raw.includes('+') || raw.includes('/') ? 'base64' : 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { id?: unknown };
    if (typeof parsed?.id === 'string' && UUID_RE.test(parsed.id)) {
      return parsed.id;
    }
  } catch {
    // fall through
  }
  throw new AppException(400, 'VALIDATION_ERROR', 'cursor is invalid.');
}

export interface Page<T> {
  data: T[];
  meta: { nextCursor: string | null; hasMore: boolean };
}

/** `rows` must be the result of a `LIMIT limit + 1` query, ordered by id DESC. */
export function buildPage<R extends { id: string }, T>(rows: R[], limit: number, map: (row: R) => T): Page<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    data: pageRows.map(map),
    meta: { nextCursor: hasMore && last ? encodeCursor(last.id) : null, hasMore },
  };
}
