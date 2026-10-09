import { Module } from '@nestjs/common';

/**
 * Business Email — reading/sending — claude/srs.md §7.6, architecture/api-contract.md §8-9.
 * Implementation-plan Step 2.4: IMAP sync, threading, search, compose/reply/
 * forward, tenant.attachment_uploads staging + quota enforcement. The
 * single largest app-code module in the MVP — see mvp-effort-estimate.md.
 */
@Module({})
export class EmailModule {}
