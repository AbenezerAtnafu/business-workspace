/**
 * Locales offered in Organization Settings. The API accepts any canonical
 * BCP 47 tag; this is the curated list the picker shows (an org that set
 * something else through the API keeps it, shown as-is).
 */
export const LOCALE_OPTIONS: { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'am-ET', label: 'Amharic (Ethiopia) — አማርኛ' },
  { value: 'om-ET', label: 'Afaan Oromoo (Ethiopia)' },
  { value: 'ti-ET', label: 'Tigrinya (Ethiopia) — ትግርኛ' },
  { value: 'so', label: 'Somali — Soomaali' },
  { value: 'sw', label: 'Swahili — Kiswahili' },
  { value: 'ar', label: 'Arabic — العربية' },
  { value: 'fr', label: 'French — Français' },
];

export function localeLabel(tag: string): string {
  return LOCALE_OPTIONS.find((l) => l.value === tag)?.label ?? tag;
}

/** Every IANA time zone the browser knows, plus UTC. */
export function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] };
  const zones = intl.supportedValuesOf?.('timeZone') ?? [];
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}

/** "Africa/Addis_Ababa" → "Africa/Addis Ababa (GMT+3)" — current offset, for the picker. */
export function timeZoneLabel(zone: string): string {
  try {
    const offset = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    return `${zone.replace(/_/g, ' ')}${offset ? ` (${offset})` : ''}`;
  } catch {
    return zone;
  }
}
