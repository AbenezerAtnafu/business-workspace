import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import path from 'node:path';
import { RateLimitModule } from '../../common/rate-limit/rate-limit.module';
import { AttachmentsService } from './attachments.service';
import { MailAccessService } from './mail-access.service';
import { MailStoreService } from './mail-store.service';
import { MailController, WebmailController } from './webmail.controller';
import { WebmailService } from './webmail.service';

/**
 * Step 2.4 — webmail (api-contract.md §8) over the mail stack of Step 2.1
 * (ADR-012). Uploads stream to disk under ATTACHMENT_STORAGE_DIR/.incoming
 * (never buffered in memory), capped at 100 MB per file
 * (business-rules-and-defaults.md); AttachmentsService then moves each
 * accepted file into place and records it in tenant.attachment_uploads.
 */
@Module({
  imports: [
    RateLimitModule,
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        dest: path.join(path.resolve(config.get<string>('mail.attachmentDir')!), '.incoming'),
        limits: { fileSize: config.get<number>('mail.maxAttachmentBytes'), files: 1, fields: 5 },
      }),
    }),
  ],
  controllers: [WebmailController, MailController],
  providers: [WebmailService, MailAccessService, MailStoreService, AttachmentsService],
})
export class WebmailModule {}
