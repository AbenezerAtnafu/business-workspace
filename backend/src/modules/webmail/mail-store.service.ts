import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { AppException } from '../../common/errors/app-exception';

/**
 * The only code that talks to the mail servers (ADR-012):
 *   - IMAP to Dovecot as "<mailbox address>*<master user>" — the master user
 *     can open any mailbox, personal or shared, and is accepted only from the
 *     internal network (master-users allow_nets). Access decisions are made
 *     BEFORE this is called (MailAccessService); this layer trusts its caller.
 *   - SMTP to Postfix's internal submission port, which the API alone reaches.
 * One short-lived IMAP connection per operation: simple, and stateless across
 * API instances. Pooling is a later optimisation if latency calls for it.
 */
@Injectable()
export class MailStoreService {
  private readonly logger = new Logger(MailStoreService.name);

  constructor(private readonly config: ConfigService) {}

  async withMailbox<T>(address: string, fn: (imap: ImapFlow) => Promise<T>): Promise<T> {
    const imap = new ImapFlow({
      host: this.config.get<string>('mail.imapHost')!,
      port: this.config.get<number>('mail.imapPort')!,
      secure: false,
      doSTARTTLS: false,
      auth: {
        user: `${address}*${this.config.get<string>('mail.masterUser')}`,
        pass: this.config.get<string>('mail.masterPassword')!,
      },
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
    });
    // An idle IMAP connection may emit 'error' later; never let that crash the process.
    imap.on('error', (err: Error) => this.logger.warn(`IMAP: ${err.message}`));
    try {
      await imap.connect();
    } catch (err) {
      this.logger.error(`IMAP connect for ${address} failed: ${(err as Error).message}`);
      throw new AppException(502, 'MAIL_SERVER_UNAVAILABLE', 'The mail server is not reachable right now. Try again shortly.');
    }
    try {
      return await fn(imap);
    } finally {
      await imap.logout().catch(() => imap.close());
    }
  }

  /** Hand a finished MIME message to Postfix for delivery (envelope given explicitly). */
  async submit(raw: Buffer, envelope: { from: string; to: string[] }): Promise<void> {
    const transport = createTransport({
      host: this.config.get<string>('mail.submitHost'),
      port: this.config.get<number>('mail.submitPort'),
      secure: false,
      ignoreTLS: true,
    });
    try {
      await transport.sendMail({ envelope, raw });
    } catch (err) {
      this.logger.error(`SMTP submit failed: ${(err as Error).message}`);
      throw new AppException(502, 'MAIL_SERVER_UNAVAILABLE', 'The message could not be handed to the mail server. Try again shortly.');
    } finally {
      transport.close();
    }
  }
}
