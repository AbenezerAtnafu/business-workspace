import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateIf,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Every IANA zone this runtime knows (Intl), plus "UTC" which some runtimes list only as "Etc/UTC". */
// `Intl.supportedValuesOf` is in Node 18+ but not in this project's TS lib target.
const supportedValuesOf = (Intl as unknown as { supportedValuesOf: (key: 'timeZone') => string[] }).supportedValuesOf;
const TIME_ZONES = new Set<string>([...supportedValuesOf('timeZone'), 'UTC']);

export function isValidTimeZone(value: unknown): value is string {
  return typeof value === 'string' && TIME_ZONES.has(value);
}

/** A well-formed BCP 47 tag that's already in canonical form ("en-GB", not "EN_gb"). */
export function isCanonicalLocale(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 35) return false;
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}

function Is(check: (v: unknown) => boolean, message: string, options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: `is_${propertyName}`,
      target: object.constructor,
      propertyName,
      options: { message, ...options },
      validator: { validate: (v: unknown) => check(v) },
    });
}

/**
 * PATCH /organization — architecture/api-contract.md §2: "Update name,
 * logo, timezone, locale." Every field optional; only the ones sent change.
 * The slug is deliberately not editable (it's the org's stable identifier),
 * and status/owner have their own flows (ownership transfer; suspension is
 * a platform action, out of MVP).
 */
export class UpdateOrganizationDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  /**
   * An https URL to an image, or null to remove it. MVP has no general
   * file upload (srs.md §7.7 is attachments-only), so the logo is a link.
   */
  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, v) => v !== null)
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'logoUrl must be an https:// URL' })
  @MaxLength(2048)
  logoUrl?: string | null;

  @IsOptional()
  @Is(isValidTimeZone, 'defaultTimezone must be an IANA time zone, e.g. "Africa/Addis_Ababa"')
  defaultTimezone?: string;

  @IsOptional()
  @Is(isCanonicalLocale, 'defaultLocale must be a canonical BCP 47 language tag, e.g. "en" or "am-ET"')
  defaultLocale?: string;
}
