import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';
import { NotificationsService } from './notifications.service';
import { UpdateNotificationDto } from './dto/update-notification.dto';

/**
 * Notifications — architecture/api-contract.md §10. Any authenticated role,
 * own notifications only. No create endpoint: every notification is
 * system-generated.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser() claims: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    return this.notifications.list(claims.organizationId, claims.userId, { limit, cursor, unreadOnly });
  }

  /** Not in api-contract.md §10's table — a small addition for the app shell's unread badge (screen-flow-inventory.md §2.10). */
  @Get('unread-count')
  async unreadCount(@CurrentUser() claims: AccessTokenClaims) {
    return { unreadCount: await this.notifications.unreadCount(claims.organizationId, claims.userId) };
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async readAll(@CurrentUser() claims: AccessTokenClaims) {
    return { updated: await this.notifications.markAllRead(claims.organizationId, claims.userId) };
  }

  @Patch(':notificationId')
  async update(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('notificationId', new ParseUUIDPipe()) notificationId: string,
    @Body() dto: UpdateNotificationDto,
  ) {
    const readAt = dto.readAt === null ? null : new Date(dto.readAt);
    return this.notifications.setReadAt(claims.organizationId, claims.userId, notificationId, readAt);
  }
}
