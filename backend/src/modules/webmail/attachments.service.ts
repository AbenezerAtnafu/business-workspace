import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app-exception';
import { MailboxAccess } from './mail-access.service';

export interface StagedAttachment {
  id: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string | null;
  /** Absolute path of the staged bytes. */
  filePath: string;
}

const GC_AFTER_HOURS = 48; // business-rules-and-defaults.md
const GC_EVERY_MS = 60 * 60 * 1000;

/**
 * Compose-time attachment staging (tenant.attachment_uploads, migration 016).
 * Files live under ATTACHMENT_STORAGE_DIR/<org>/<uuid>; the row records who
 * uploaded what for which mailbox. Once a message or draft uses an upload it
 * is marked consumed and its file deleted — the bytes now live in the MIME
 * message Dovecot stores. Unconsumed uploads are removed after 48 h.
 */
@Injectable()
export class AttachmentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttachmentsService.name);
  private timer?: NodeJS.Timeout;
  readonly root: string;

  constructor(
    private readonly db: DatabaseService,
    config: ConfigService,
  ) {
    this.root = path.resolve(config.get<string>('mail.attachmentDir')!);
  }

  onModuleInit(): void {
    fs.mkdirSync(path.join(this.root, '.incoming'), { recursive: true });
    this.timer = setInterval(
      () => void this.collectGarbage().catch((e) => this.logger.warn(`GC: ${e.message}`)),
      GC_EVERY_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Where multer writes uploads before we know they're acceptable. */
  get incomingDir(): string {
    return path.join(this.root, '.incoming');
  }

  async stage(
    access: MailboxAccess,
    userId: string,
    file: {
      path: string;
      originalname: string;
      size: number;
      mimetype?: string;
    },
  ): Promise<StagedAttachment> {
    const id = randomUUID();
    const key = path.join(access.organizationId, id);
    const dest = path.join(this.root, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file.path, dest);
    const fileName = sanitizeFileName(file.originalname);
    let rows: { id: string }[];
    try {
      ({ rows } = await this.db.withTransaction(async (client) => {
        await this.db.setTenantContext(client, access.organizationId);
        return client.query<{ id: string }>(
          `INSERT INTO tenant.attachment_uploads (organization_id, mailbox_id, uploaded_by, object_storage_key, file_name, size_bytes, mime_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [access.organizationId, access.mailboxId, userId, key, fileName, file.size, file.mimetype ?? null],
        );
      }));
    } catch (err) {
      fs.rmSync(dest, { force: true });
      throw err;
    }
    return {
      id: rows[0].id,
      fileName,
      sizeBytes: file.size,
      mimeType: file.mimetype ?? null,
      filePath: dest,
    };
  }

  /** The caller's own, unconsumed uploads for this mailbox — anything else is a 400. */
  async claim(access: MailboxAccess, userId: string, ids: string[]): Promise<StagedAttachment[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, access.organizationId);
      return client.query<{
        id: string;
        file_name: string;
        size_bytes: string;
        mime_type: string | null;
        object_storage_key: string;
      }>(
        `SELECT id, file_name, size_bytes, mime_type, object_storage_key FROM tenant.attachment_uploads
         WHERE id = ANY($1::uuid[]) AND mailbox_id = $2 AND uploaded_by = $3 AND consumed_at IS NULL`,
        [ids, access.mailboxId, userId],
      );
    });
    if (rows.length !== new Set(ids).size) {
      throw new AppException(
        400,
        'VALIDATION_ERROR',
        'One or more attachments are unknown, already used, or not yours.',
        {
          field: 'attachmentIds',
        },
      );
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => {
      const r = byId.get(id)!;
      return {
        id: r.id,
        fileName: r.file_name,
        sizeBytes: Number(r.size_bytes),
        mimeType: r.mime_type,
        filePath: path.join(this.root, r.object_storage_key),
      };
    });
  }

  async markConsumed(organizationId: string, staged: StagedAttachment[]): Promise<void> {
    if (staged.length === 0) return;
    await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, organizationId);
      await client.query('UPDATE tenant.attachment_uploads SET consumed_at = now() WHERE id = ANY($1::uuid[])', [
        staged.map((s) => s.id),
      ]);
    });
    for (const s of staged) fs.rm(s.filePath, { force: true }, () => undefined);
  }

  /** Bytes staged for this mailbox and not yet used — they count against its quota. */
  async pendingBytes(access: MailboxAccess): Promise<number> {
    const { rows } = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, access.organizationId);
      return client.query<{ total: string | null }>(
        'SELECT sum(size_bytes) AS total FROM tenant.attachment_uploads WHERE mailbox_id = $1 AND consumed_at IS NULL',
        [access.mailboxId],
      );
    });
    return Number(rows[0]?.total ?? 0);
  }

  /** Drop an upload that was refused before it was staged. */
  async discard(filePath: string): Promise<void> {
    await fs.promises.rm(filePath, { force: true });
  }

  /** Delete unconsumed uploads older than 48 h (rows and files). Runs hourly. */
  async collectGarbage(): Promise<number> {
    // Cross-org by nature, but the API role is RLS-bound (ADR-004), so it
    // walks the organizations and cleans each one inside its own tenant context.
    const orgs = await this.db.query<{ id: string }>('SELECT id FROM control.organizations');
    let removed = 0;
    for (const org of orgs.rows) {
      const { rows } = await this.db.withTransaction(async (client) => {
        await this.db.setTenantContext(client, org.id);
        return client.query<{ object_storage_key: string }>(
          `DELETE FROM tenant.attachment_uploads
           WHERE consumed_at IS NULL AND created_at < now() - make_interval(hours => $1)
           RETURNING object_storage_key`,
          [GC_AFTER_HOURS],
        );
      });
      for (const r of rows) fs.rm(path.join(this.root, r.object_storage_key), { force: true }, () => undefined);
      removed += rows.length;
    }
    // Stray temp files (an upload interrupted mid-request, a crash between
    // multer writing and the request finishing): anything older than an hour.
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const f of fs.readdirSync(this.incomingDir)) {
      const p = path.join(this.incomingDir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      } catch {
        /* already gone */
      }
    }
    if (removed) this.logger.log(`GC: removed ${removed} abandoned attachment upload(s)`);
    return removed;
  }
}

/** Keep the name readable, drop path parts and control characters. */
export function sanitizeFileName(name: string): string {
  const base = path
    .basename(name || 'attachment')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (base || 'attachment').slice(0, 255);
}
