import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lowerAll = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : v)) : value;

/**
 * POST /mailboxes/{id}/messages and the drafts endpoints (api-contract.md §8).
 * Recipients are plain addresses; the total across to/cc/bcc is capped (100)
 * in the service, which also requires at least one for sending (a draft may
 * have none yet).
 */
export class ComposeDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @Transform(lowerAll)
  @IsEmail({}, { each: true, message: 'to: every entry must be an email address' })
  to?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @Transform(lowerAll)
  @IsEmail({}, { each: true, message: 'cc: every entry must be an email address' })
  cc?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @Transform(lowerAll)
  @IsEmail({}, { each: true, message: 'bcc: every entry must be an email address' })
  bcc?: string[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(998)
  subject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5_000_000)
  bodyText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000_000)
  bodyHtml?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  attachmentIds?: string[];

  /** API id of the message being replied to (sets In-Reply-To/References). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  inReplyTo?: string | null;
}

/** PATCH /mailboxes/{id}/drafts/{messageId}: omitted fields keep the draft's current value. */
export class UpdateDraftDto extends ComposeDto {
  /** Which of the draft's current attachments (by attachmentId) to keep; omitted = keep all. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  keepAttachmentIds?: string[];
}

export class UpdateMessageDto {
  /** Move to another folder (e.g. "trash", or back to "inbox"). */
  @IsOptional()
  @IsString()
  folder?: string;

  /** ISO time = mark read; null = mark unread. */
  @IsOptional()
  @IsISO8601()
  readAt?: string | null;

  @IsOptional()
  @IsBoolean()
  flagged?: boolean;
}

// re-exported for symmetry with other modules' dto folders
export { Type, ValidateNested };
