import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { FetchMessageObject, ImapFlow, MessageAddressObject, MessageStructureObject } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import { AppException } from '../../common/errors/app-exception';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';
import { AttachmentsService, StagedAttachment } from './attachments.service';
import { MailAccessService, MailboxAccess } from './mail-access.service';
import { MailStoreService } from './mail-store.service';
import { decodeMessageId, encodeMessageId, folderPath, FOLDERS, FolderId } from './message-id';
import type { ComposeDto, UpdateDraftDto, UpdateMessageDto } from './dto/compose.dto';

export interface Address {
  name: string | null;
  address: string;
}

export interface MessageSummary {
  id: string;
  folder: FolderId;
  subject: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  date: string | null;
  read: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  sizeBytes: number;
}

export interface AttachmentMeta {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  inline: boolean;
}

export interface MessageDetail extends MessageSummary {
  bcc: Address[];
  replyTo: Address[];
  messageIdHeader: string | null;
  inReplyTo: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: AttachmentMeta[];
}

/** An attachment carried into a new MIME message: freshly staged, or kept from a draft. */
type OutgoingAttachment = { filename: string; contentType?: string } & ({ path: string } | { content: Buffer });

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

/**
 * Webmail — api-contract.md §8: a REST face over the mailbox's IMAP store
 * (Dovecot) and the internal submission port (Postfix). Every public method
 * resolves the caller's access FIRST (MailAccessService) and only then
 * touches the mail store, which trusts its caller.
 *
 * Message ids are folder+UIDVALIDITY+UID (message-id.ts), so moving a message
 * or rewriting a draft gives it a new id; the response always carries it.
 */
@Injectable()
export class WebmailService {
  constructor(
    private readonly access: MailAccessService,
    private readonly store: MailStoreService,
    private readonly attachments: AttachmentsService,
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  // --- mailboxes & folders ----------------------------------------------------

  /** GET /mail/mailboxes — what the mailbox switcher shows, with unread Inbox counts. */
  async listMailboxes(claims: AccessTokenClaims) {
    const boxes = await this.access.listForUser(claims);
    const data = await Promise.all(
      boxes.map(async (b) => {
        let unread: number | null = null;
        if (b.status === 'active') {
          unread = await this.store
            .withMailbox(b.address, async (imap) => {
              const s = await imap.status(FOLDERS.inbox, { unseen: true });
              return s ? (s.unseen ?? 0) : null;
            })
            .catch(() => null); // one unreachable mailbox must not break the switcher
        }
        return { mailboxId: b.id, address: b.address, isShared: b.isShared, access: b.access, status: b.status, unread };
      }),
    );
    return { data };
  }

  /** GET /mailboxes/{id}/folders — the fixed four, with counts, plus the mailbox quota. */
  async listFolders(claims: AccessTokenClaims, mailboxId: string) {
    const access = await this.access.resolve(claims, mailboxId, 'read');
    return this.store.withMailbox(access.address, async (imap) => {
      const data = [];
      for (const [id, path] of Object.entries(FOLDERS)) {
        const s = await imap.status(path, { messages: true, unseen: true });
        data.push({ folder: id, total: s ? (s.messages ?? 0) : 0, unread: s ? (s.unseen ?? 0) : 0 });
      }
      const q = await imap.getQuota(FOLDERS.inbox).catch(() => false as const);
      const storage = q && q.storage ? q.storage : null;
      return {
        data,
        quota: storage ? { usedBytes: storage.usage ?? 0, limitBytes: storage.limit ?? null } : null,
        access: access.level,
      };
    });
  }

  /** GET /mailboxes/{id}/folders/{folder}/messages — newest first, cursor = last UID seen. */
  async listMessages(
    claims: AccessTokenClaims,
    mailboxId: string,
    folder: string,
    opts: { cursor?: string; limit?: number; q?: string; unreadOnly?: boolean },
  ) {
    const access = await this.access.resolve(claims, mailboxId, 'read');
    const path = folderPath(folder);
    const limit = Math.min(Math.max(Number(opts.limit) || PAGE_DEFAULT, 1), PAGE_MAX);
    const before = opts.cursor && /^\d+$/.test(opts.cursor) ? Number(opts.cursor) : null;
    const q = opts.q?.trim();

    return this.store.withMailbox(access.address, async (imap) => {
      const box = await imap.mailboxOpen(path, { readOnly: true });
      const criteria: Record<string, unknown> = {};
      if (opts.unreadOnly) criteria.seen = false;
      if (q) criteria.text = q; // IMAP TEXT: headers + body, Dovecot does the matching
      if (Object.keys(criteria).length === 0) criteria.all = true;

      let uids = ((await imap.search(criteria, { uid: true })) || []) as number[];
      uids = uids.sort((a, b) => b - a);
      if (before !== null) uids = uids.filter((u) => u < before);
      const page = uids.slice(0, limit);
      if (page.length === 0) return { data: [], meta: { nextCursor: null, hasMore: false } };

      const fetched = await imap.fetchAll(
        page.join(','),
        { uid: true, envelope: true, flags: true, bodyStructure: true, size: true, internalDate: true },
        { uid: true },
      );
      const data = fetched
        .sort((a, b) => b.uid - a.uid)
        .map((m) => toSummary(folder as FolderId, box.uidValidity, m));
      const hasMore = uids.length > page.length;
      return { data, meta: { nextCursor: hasMore ? String(page[page.length - 1]) : null, hasMore } };
    });
  }

  // --- one message -------------------------------------------------------------

  /** GET /mailboxes/{id}/messages/{messageId} — full message; does NOT mark it read (the UI PATCHes readAt). */
  async getMessage(claims: AccessTokenClaims, mailboxId: string, messageId: string): Promise<MessageDetail> {
    const access = await this.access.resolve(claims, mailboxId, 'read');
    const ref = decodeMessageId(messageId);
    return this.store.withMailbox(access.address, async (imap) => {
      const { msg, uidValidity } = await this.fetchSource(imap, ref);
      const parsed = await simpleParser(msg.source!);
      return toDetail(ref.folder, uidValidity, msg, parsed);
    });
  }

  /** GET .../attachments/{attachmentId} — the attachment's bytes. */
  async getAttachment(claims: AccessTokenClaims, mailboxId: string, messageId: string, attachmentId: string) {
    const access = await this.access.resolve(claims, mailboxId, 'read');
    const ref = decodeMessageId(messageId);
    return this.store.withMailbox(access.address, async (imap) => {
      const { msg } = await this.fetchSource(imap, ref);
      const parsed = await simpleParser(msg.source!);
      const index = /^\d+$/.test(attachmentId) ? Number(attachmentId) : -1;
      const att = parsed.attachments[index];
      if (!att) throw new AppException(404, 'NOT_FOUND', 'Attachment not found.');
      return {
        fileName: att.filename || `attachment-${index + 1}`,
        mimeType: att.contentType || 'application/octet-stream',
        content: att.content,
      };
    });
  }

  /** PATCH /mailboxes/{id}/messages/{messageId} — read/unread, flag, move. Returns the (possibly new) id. */
  async updateMessage(claims: AccessTokenClaims, mailboxId: string, messageId: string, dto: UpdateMessageDto) {
    const access = await this.access.resolve(claims, mailboxId, 'write');
    const ref = decodeMessageId(messageId);
    const target = dto.folder !== undefined ? (folderPath(dto.folder), dto.folder as FolderId) : null;
    if (target === 'drafts' && ref.folder !== 'drafts') {
      throw new AppException(422, 'INVALID_MOVE', 'Messages cannot be moved into Drafts.');
    }
    return this.store.withMailbox(access.address, async (imap) => {
      const box = await this.openChecked(imap, ref);
      const uid = String(ref.uid);
      if (dto.readAt !== undefined) {
        if (dto.readAt === null) await imap.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
        else await imap.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      }
      if (dto.flagged !== undefined) {
        if (dto.flagged) await imap.messageFlagsAdd(uid, ['\\Flagged'], { uid: true });
        else await imap.messageFlagsRemove(uid, ['\\Flagged'], { uid: true });
      }
      if (target && target !== ref.folder) {
        const res = await imap.messageMove(uid, FOLDERS[target], { uid: true });
        const newUid = res && res.uidMap ? res.uidMap.get(ref.uid) : undefined;
        if (!res || newUid === undefined || res.uidValidity === undefined) {
          throw new AppException(502, 'MAIL_SERVER_UNAVAILABLE', 'The message could not be moved. Try again shortly.');
        }
        return { messageId: encodeMessageId(target, res.uidValidity, newUid), folder: target };
      }
      return { messageId: encodeMessageId(ref.folder, box.uidValidity, ref.uid), folder: ref.folder };
    });
  }

  /** DELETE /mailboxes/{id}/messages/{messageId} — permanent, and only from Trash. */
  async deleteMessage(claims: AccessTokenClaims, mailboxId: string, messageId: string): Promise<void> {
    const access = await this.access.resolve(claims, mailboxId, 'write');
    const ref = decodeMessageId(messageId);
    if (ref.folder !== 'trash' && ref.folder !== 'drafts') {
      throw new AppException(422, 'MESSAGE_NOT_IN_TRASH', 'Move the message to Trash first; only Trash can be emptied permanently.');
    }
    await this.store.withMailbox(access.address, async (imap) => {
      await this.openChecked(imap, ref);
      await imap.messageDelete(String(ref.uid), { uid: true });
    });
  }

  // --- sending & drafts ----------------------------------------------------------

  /** POST /mailboxes/{id}/messages — compose and send now. */
  async send(claims: AccessTokenClaims, mailboxId: string, dto: ComposeDto) {
    const access = await this.access.resolve(claims, mailboxId, 'write');
    this.assertSendable(dto.to, dto.cc, dto.bcc);
    const staged = await this.attachments.claim(access, claims.userId, dto.attachmentIds ?? []);
    const threading = dto.inReplyTo ? await this.threadingFor(access, dto.inReplyTo) : {};
    const result = await this.deliver(access, {
      to: dto.to ?? [],
      cc: dto.cc ?? [],
      bcc: dto.bcc ?? [],
      subject: dto.subject ?? '',
      text: dto.bodyText,
      html: dto.bodyHtml,
      attachments: staged.map(stagedToOutgoing),
      ...threading,
    });
    await this.attachments.markConsumed(access.organizationId, staged);
    return result;
  }

  /** POST /mailboxes/{id}/drafts */
  async createDraft(claims: AccessTokenClaims, mailboxId: string, dto: ComposeDto) {
    const access = await this.access.resolve(claims, mailboxId, 'write');
    const staged = await this.attachments.claim(access, claims.userId, dto.attachmentIds ?? []);
    const threading = dto.inReplyTo ? await this.threadingFor(access, dto.inReplyTo) : {};
    const raw = await compose(this.fromFor(access), {
      to: dto.to ?? [],
      cc: dto.cc ?? [],
      bcc: dto.bcc ?? [],
      subject: dto.subject ?? '',
      text: dto.bodyText,
      html: dto.bodyHtml,
      attachments: staged.map(stagedToOutgoing),
      ...threading,
      keepBcc: true,
    });
    const id = await this.appendTo(access, 'drafts', raw, ['\\Draft', '\\Seen']);
    await this.attachments.markConsumed(access.organizationId, staged);
    return { messageId: id };
  }

  /**
   * PATCH /mailboxes/{id}/drafts/{messageId} — replaces the draft. Fields left
   * out keep their current value; `keepAttachmentIds` picks which of the
   * draft's current attachments survive (default: all), `attachmentIds` adds
   * newly staged ones. IMAP can't edit a message, so this appends the new
   * version and deletes the old one: the draft gets a new id (returned).
   */
  async updateDraft(claims: AccessTokenClaims, mailboxId: string, messageId: string, dto: UpdateDraftDto) {
    const access = await this.access.resolve(claims, mailboxId, 'write');
    const ref = decodeMessageId(messageId);
    if (ref.folder !== 'drafts') throw new AppException(404, 'NOT_FOUND', 'Draft not found.');
    const staged = await this.attachments.claim(access, claims.userId, dto.attachmentIds ?? []);

    const newId = await this.store.withMailbox(access.address, async (imap) => {
      const { msg } = await this.fetchSource(imap, ref);
      const current = await simpleParser(msg.source!);
      const keep = dto.keepAttachmentIds;
      const carried: OutgoingAttachment[] = current.attachments
        .map((a, i) => ({ a, i }))
        .filter(({ i }) => keep === undefined || keep.includes(String(i)))
        .map(({ a, i }) => ({ filename: a.filename || `attachment-${i + 1}`, contentType: a.contentType, content: a.content }));

      const raw = await compose(this.fromFor(access), {
        to: dto.to ?? addressList(current.to),
        cc: dto.cc ?? addressList(current.cc),
        bcc: dto.bcc ?? addressList(current.bcc),
        subject: dto.subject ?? current.subject ?? '',
        text: dto.bodyText !== undefined ? dto.bodyText : plainText(current) || undefined,
        html: dto.bodyHtml !== undefined ? dto.bodyHtml : typeof current.html === 'string' ? current.html : undefined,
        attachments: [...carried, ...staged.map(stagedToOutgoing)],
        inReplyTo: current.inReplyTo,
        references: referencesOf(current),
        keepBcc: true,
      });
      const appended = await imap.append(FOLDERS.drafts, raw, ['\\Draft', '\\Seen']);
      if (!appended || appended.uid === undefined || appended.uidValidity === undefined) {
        throw new AppException(502, 'MAIL_SERVER_UNAVAILABLE', 'The draft could not be saved. Try again shortly.');
      }
      await imap.mailboxOpen(FOLDERS.drafts);
      await imap.messageDelete(String(ref.uid), { uid: true });
      return encodeMessageId('drafts', appended.uidValidity, appended.uid);
    });
    await this.attachments.markConsumed(access.organizationId, staged);
    return { messageId: newId };
  }

  /** POST /mailboxes/{id}/drafts/{messageId}/send — send the saved draft as it is, then remove it. */
  async sendDraft(claims: AccessTokenClaims, mailboxId: string, messageId: string) {
    const access = await this.access.resolve(claims, mailboxId, 'write');
    const ref = decodeMessageId(messageId);
    if (ref.folder !== 'drafts') throw new AppException(404, 'NOT_FOUND', 'Draft not found.');

    const draft = await this.store.withMailbox(access.address, async (imap) => {
      const { msg } = await this.fetchSource(imap, ref);
      return simpleParser(msg.source!);
    });
    const to = addressList(draft.to);
    const cc = addressList(draft.cc);
    const bcc = addressList(draft.bcc);
    this.assertSendable(to, cc, bcc);
    const result = await this.deliver(access, {
      to,
      cc,
      bcc,
      subject: draft.subject ?? '',
      text: plainText(draft) || undefined,
      html: typeof draft.html === 'string' ? draft.html : undefined,
      attachments: draft.attachments.map((a, i) => ({
        filename: a.filename || `attachment-${i + 1}`,
        contentType: a.contentType,
        content: a.content,
      })),
      inReplyTo: draft.inReplyTo,
      references: referencesOf(draft),
    });
    await this.store.withMailbox(access.address, async (imap) => {
      await imap.mailboxOpen(FOLDERS.drafts);
      await imap.messageDelete(String(ref.uid), { uid: true });
    });
    return result;
  }

  /** POST /mailboxes/{id}/attachments — stage one upload (multer has already written it to disk). */
  async stageAttachment(
    claims: AccessTokenClaims,
    mailboxId: string,
    file: { path: string; originalname: string; size: number; mimetype?: string },
  ) {
    // Multer has already written the file; whatever goes wrong from here on
    // (no access, over quota, DB error), it must not stay on disk.
    try {
      return await this.stageChecked(claims, mailboxId, file);
    } catch (err) {
      await this.attachments.discard(file.path);
      throw err;
    }
  }

  private async stageChecked(
    claims: AccessTokenClaims,
    mailboxId: string,
    file: { path: string; originalname: string; size: number; mimetype?: string },
  ) {
    const access = await this.access.resolve(claims, mailboxId, 'write');
    // The upload counts against the mailbox's quota (api-contract.md §8): what
    // Dovecot already stores + what's staged and not yet used + this file.
    const quota = await this.store
      .withMailbox(access.address, async (imap) => {
        const q = await imap.getQuota(FOLDERS.inbox);
        return q && q.storage ? q.storage : null;
      })
      .catch(() => null);
    if (quota && quota.limit) {
      const pending = await this.attachments.pendingBytes(access);
      if ((quota.usage ?? 0) + pending + file.size > quota.limit) {
        throw new AppException(413, 'MAILBOX_QUOTA_EXCEEDED', 'This attachment would put the mailbox over its storage limit.', {
          limitBytes: quota.limit,
          usedBytes: (quota.usage ?? 0) + pending,
        });
      }
    }
    const staged = await this.attachments.stage(access, claims.userId, file);
    return { attachmentId: staged.id, fileName: staged.fileName, sizeBytes: staged.sizeBytes, mimeType: staged.mimeType };
  }

  // --- internals -------------------------------------------------------------------

  private assertSendable(to?: string[], cc?: string[], bcc?: string[]) {
    const total = (to?.length ?? 0) + (cc?.length ?? 0) + (bcc?.length ?? 0);
    if (total === 0) throw new AppException(400, 'VALIDATION_ERROR', 'Add at least one recipient.', { field: 'to' });
    const max = this.config.get<number>('mail.maxRecipients') ?? 100;
    if (total > max) {
      throw new AppException(400, 'VALIDATION_ERROR', `A message can have at most ${max} recipients in total.`, { field: 'to' });
    }
  }

  private fromFor(access: MailboxAccess): Mail.Address {
    return { name: access.displayName ?? '', address: access.address };
  }

  /**
   * The one send path: quota, MIME, Postfix, then a copy in Sent. Bcc goes in
   * the envelope only — never in the headers recipients see — but stays on
   * the Sent copy so the sender can see who they Bcc'd.
   */
  private async deliver(access: MailboxAccess, mail: ComposeFields) {
    // ADR-011 volume quota: sends per mailbox per hour, whoever sends.
    await this.rateLimit.consume(
      this.rateLimit.key('mail-send', access.mailboxId, 'mailbox'),
      this.rateLimit.quota('sendsPerMailboxPerHour'),
    );
    const from = this.fromFor(access);
    const messageId = `<${randomUUID()}@${access.address.split('@')[1]}>`;
    const date = new Date();
    const wire = await compose(from, { ...mail, messageId, date, keepBcc: false });
    const recipients = [...mail.to, ...mail.cc, ...mail.bcc];
    await this.store.submit(wire, { from: access.address, to: recipients });

    const sentCopy = mail.bcc.length ? await compose(from, { ...mail, messageId, date, keepBcc: true }) : wire;
    // Delivery already happened; a failed Sent copy must not turn into a "send failed" the user retries.
    const id = await this.appendTo(access, 'sent', sentCopy, ['\\Seen']).catch(() => null);
    return { messageId: id, sent: true };
  }

  private async appendTo(access: MailboxAccess, folder: FolderId, raw: Buffer, flags: string[]): Promise<string> {
    return this.store.withMailbox(access.address, async (imap) => {
      const res = await imap.append(FOLDERS[folder], raw, flags);
      if (!res || res.uid === undefined || res.uidValidity === undefined) {
        throw new AppException(502, 'MAIL_SERVER_UNAVAILABLE', 'The mail server did not confirm the save. Try again shortly.');
      }
      return encodeMessageId(folder, res.uidValidity, res.uid);
    });
  }

  /** In-Reply-To / References for a reply, from the original message in the same mailbox. */
  private async threadingFor(access: MailboxAccess, apiId: string): Promise<{ inReplyTo?: string; references?: string[] }> {
    const ref = decodeMessageId(apiId);
    return this.store.withMailbox(access.address, async (imap) => {
      const { msg } = await this.fetchSource(imap, ref);
      const original = await simpleParser(msg.source!);
      if (!original.messageId) return {};
      return { inReplyTo: original.messageId, references: [...referencesOf(original), original.messageId] };
    });
  }

  /** Open the message's folder and check its UIDVALIDITY still matches the id. */
  private async openChecked(imap: ImapFlow, ref: { folder: FolderId; uidValidity: string; uid: number }) {
    const box = await imap.mailboxOpen(FOLDERS[ref.folder]);
    if (String(box.uidValidity) !== ref.uidValidity) throw new AppException(404, 'NOT_FOUND', 'Message not found.');
    return box;
  }

  private async fetchSource(imap: ImapFlow, ref: { folder: FolderId; uidValidity: string; uid: number }) {
    const box = await imap.mailboxOpen(FOLDERS[ref.folder], { readOnly: true });
    if (String(box.uidValidity) !== ref.uidValidity) throw new AppException(404, 'NOT_FOUND', 'Message not found.');
    // readOnly mailbox + BODY.PEEK: reading never sets \Seen as a side effect.
    const msg = await imap.fetchOne(
      String(ref.uid),
      { uid: true, source: true, flags: true, envelope: true, bodyStructure: true, size: true, internalDate: true },
      { uid: true },
    );
    if (!msg || !msg.source) throw new AppException(404, 'NOT_FOUND', 'Message not found.');
    return { msg, uidValidity: box.uidValidity };
  }
}

// --- MIME & mapping helpers (pure) -------------------------------------------------

interface ComposeFields {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments: OutgoingAttachment[];
  inReplyTo?: string;
  references?: string[];
}

function compose(
  from: Mail.Address,
  f: ComposeFields & { messageId?: string; date?: Date; keepBcc: boolean },
): Promise<Buffer> {
  const composer = new MailComposer({
    from,
    to: f.to,
    cc: f.cc.length ? f.cc : undefined,
    bcc: f.bcc.length ? f.bcc : undefined,
    subject: f.subject,
    text: f.text,
    html: f.html,
    attachments: f.attachments,
    inReplyTo: f.inReplyTo,
    references: f.references && f.references.length ? f.references : undefined,
    messageId: f.messageId,
    date: f.date ?? new Date(),
  });
  const node = composer.compile();
  (node as unknown as { keepBcc: boolean }).keepBcc = f.keepBcc;
  return node.build();
}

function stagedToOutgoing(s: StagedAttachment): OutgoingAttachment {
  return { filename: s.fileName, contentType: s.mimeType ?? undefined, path: s.filePath };
}

function addressList(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return [];
  const groups = Array.isArray(field) ? field : [field];
  return groups.flatMap((g) => g.value.map((v) => v.address).filter((a): a is string => !!a));
}

/**
 * The text part without the line break MIME encoding leaves at its end — so a
 * draft saved and reopened N times doesn't grow N blank lines.
 */
function plainText(m: ParsedMail): string {
  return (m.text ?? '').replace(/\r?\n$/, '');
}

function referencesOf(m: ParsedMail): string[] {
  if (!m.references) return [];
  return Array.isArray(m.references) ? m.references : [m.references];
}

function addr(a: MessageAddressObject | undefined): Address | null {
  if (!a || !a.address) return null;
  return { name: a.name || null, address: a.address.toLowerCase() };
}

function addrs(list: MessageAddressObject[] | undefined): Address[] {
  return (list ?? []).map(addr).filter((a): a is Address => a !== null);
}

function parsedAddrs(field: AddressObject | AddressObject[] | undefined): Address[] {
  if (!field) return [];
  const groups = Array.isArray(field) ? field : [field];
  return groups.flatMap((g) =>
    g.value.filter((v) => v.address).map((v) => ({ name: v.name || null, address: v.address!.toLowerCase() })),
  );
}

function hasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  if (node.dispositionParameters?.filename && node.disposition !== 'inline') return true;
  return (node.childNodes ?? []).some(hasAttachment);
}

function isoDate(d: Date | string | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toSummary(folder: FolderId, uidValidity: bigint, m: FetchMessageObject): MessageSummary {
  const env = m.envelope;
  return {
    id: encodeMessageId(folder, uidValidity, m.uid),
    folder,
    subject: env?.subject ?? '',
    from: addr(env?.from?.[0]),
    to: addrs(env?.to),
    cc: addrs(env?.cc),
    date: isoDate(env?.date) ?? isoDate(m.internalDate),
    read: m.flags?.has('\\Seen') ?? false,
    flagged: m.flags?.has('\\Flagged') ?? false,
    hasAttachments: hasAttachment(m.bodyStructure),
    sizeBytes: m.size ?? 0,
  };
}

function toDetail(folder: FolderId, uidValidity: bigint, m: FetchMessageObject, p: ParsedMail): MessageDetail {
  const summary = toSummary(folder, uidValidity, m);
  return {
    ...summary,
    subject: p.subject ?? summary.subject,
    from: parsedAddrs(p.from)[0] ?? summary.from,
    to: parsedAddrs(p.to),
    cc: parsedAddrs(p.cc),
    bcc: parsedAddrs(p.bcc),
    replyTo: parsedAddrs(p.replyTo),
    date: isoDate(p.date) ?? summary.date,
    messageIdHeader: p.messageId ?? null,
    inReplyTo: p.inReplyTo ?? null,
    bodyText: p.text !== undefined ? plainText(p) : null,
    bodyHtml: typeof p.html === 'string' ? p.html : null,
    hasAttachments: p.attachments.some((a) => a.contentDisposition !== 'inline'),
    attachments: p.attachments.map((a, i) => ({
      attachmentId: String(i),
      fileName: a.filename || `attachment-${i + 1}`,
      mimeType: a.contentType || 'application/octet-stream',
      sizeBytes: a.size ?? a.content.length,
      inline: a.contentDisposition === 'inline',
    })),
  };
}
