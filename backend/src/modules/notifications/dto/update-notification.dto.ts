import { IsDateString, ValidateIf } from 'class-validator';

/**
 * PATCH /notifications/{notificationId} — api-contract.md §10:
 * `{ "readAt": "..." }`. `null` marks it unread again. Required (not
 * optional): a PATCH with no readAt has nothing to do.
 */
export class UpdateNotificationDto {
  @ValidateIf((_, value) => value !== null)
  @IsDateString({}, { message: 'readAt must be an ISO 8601 date-time or null' })
  readAt!: string | null;
}
