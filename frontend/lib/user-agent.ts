/**
 * Best-effort "Chrome on macOS" label from a stored User-Agent string, for
 * the Active Sessions list. Deliberately tiny — no UA-parsing dependency;
 * anything unrecognised falls back to "Unknown device".
 */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';

  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /curl|PostmanRuntime|okhttp|python-requests/i.test(ua)
              ? 'API client'
              : null;

  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;

  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Unknown device';
}
