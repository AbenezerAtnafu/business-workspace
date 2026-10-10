import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AppException } from '../../common/errors/app-exception';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ComposeDto, UpdateDraftDto, UpdateMessageDto } from './dto/compose.dto';
import { WebmailService } from './webmail.service';

/**
 * Business Email — reading & sending — architecture/api-contract.md §8.
 * No @Roles(): access is per mailbox, not per role — MailAccessService
 * decides (owner of the personal mailbox, or a grant directly or through a
 * group; read_only grantees get 403 on everything but GETs). An Owner/Admin
 * role alone does not open anyone's mail.
 */
@Controller('mailboxes/:mailboxId')
export class WebmailController {
  constructor(private readonly webmail: WebmailService) {}

  @Get('folders')
  folders(@CurrentUser() claims: AccessTokenClaims, @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string) {
    return this.webmail.listFolders(claims, mailboxId);
  }

  @Get('folders/:folder/messages')
  messages(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Param('folder') folder: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    return this.webmail.listMessages(claims, mailboxId, folder, {
      cursor,
      limit: limit ? Number(limit) : undefined,
      q,
      unreadOnly: unreadOnly === 'true',
    });
  }

  @Get('messages/:messageId')
  message(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.webmail.getMessage(claims, mailboxId, messageId);
  }

  @Get('messages/:messageId/attachments/:attachmentId')
  async attachment(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Param('messageId') messageId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const a = await this.webmail.getAttachment(claims, mailboxId, messageId, attachmentId);
    // Always a download, never rendered by the browser on the API's origin:
    // an attached .html/.svg must not run as this site.
    res.setHeader('Content-Type', a.mimeType);
    res.setHeader('Content-Length', String(a.content.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', contentDisposition(a.fileName));
    res.end(a.content);
  }

  @Patch('messages/:messageId')
  update(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Param('messageId') messageId: string,
    @Body() dto: UpdateMessageDto,
  ) {
    return this.webmail.updateMessage(claims, mailboxId, messageId, dto);
  }

  @Delete('messages/:messageId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Param('messageId') messageId: string,
  ) {
    await this.webmail.deleteMessage(claims, mailboxId, messageId);
    return {};
  }

  @Post('attachments')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new AppException(400, 'VALIDATION_ERROR', 'Attach a file in the "file" field.', { field: 'file' });
    return this.webmail.stageAttachment(claims, mailboxId, file);
  }

  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  send(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Body() dto: ComposeDto,
  ) {
    return this.webmail.send(claims, mailboxId, dto);
  }

  @Post('drafts')
  @HttpCode(HttpStatus.CREATED)
  createDraft(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Body() dto: ComposeDto,
  ) {
    return this.webmail.createDraft(claims, mailboxId, dto);
  }

  @Patch('drafts/:messageId')
  updateDraft(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Param('messageId') messageId: string,
    @Body() dto: UpdateDraftDto,
  ) {
    return this.webmail.updateDraft(claims, mailboxId, messageId, dto);
  }

  @Post('drafts/:messageId/send')
  @HttpCode(HttpStatus.CREATED)
  sendDraft(
    @CurrentUser() claims: AccessTokenClaims,
    @Param('mailboxId', new ParseUUIDPipe()) mailboxId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.webmail.sendDraft(claims, mailboxId, messageId);
  }
}

/** GET /mail/mailboxes — the mailboxes the caller can open in webmail. */
@Controller('mail')
export class MailController {
  constructor(private readonly webmail: WebmailService) {}

  @Get('mailboxes')
  mailboxes(@CurrentUser() claims: AccessTokenClaims) {
    return this.webmail.listMailboxes(claims);
  }
}

/** RFC 6266 filename with an ASCII fallback. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
