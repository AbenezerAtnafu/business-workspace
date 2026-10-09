import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  /**
   * Overrides the configured default sender for this one send. Added for
   * Step 2.2: business-rules-and-defaults.md's invite-delivery exception
   * says invites go out "from a reserved address like
   * invitations@<org's primary domain>", not the platform's own global
   * SMTP_RELAY_FROM — a real gap in Step 1.6's original invite-send call,
   * which had no Domains module yet to source a primary domain from, and
   * fell back to the global default unconditionally. Omit to keep using
   * that default.
   */
  from?: string;
}

/**
 * The "narrow, easy-to-miss dependency" flagged in planning/implementation-plan.md's
 * Step 1.4 note: invite/password-reset links need to go out as real email
 * regardless of when the full self-hosted mail stack (Step 2.1, ADR-002)
 * lands, via the same bootstrap relay planned for Business Email's outbound
 * bootstrap. This is that narrow pre-cut — transactional sends only, one
 * relay (SMTP_RELAY_*), no templating engine, no queue.
 *
 * With SMTP_RELAY_HOST unset (true of every environment so far, including
 * this one), there's no real relay to point at, so sends are logged instead
 * of attempted — loudly, so this is never mistaken for working delivery in
 * an environment that's actually supposed to send mail. This is also the
 * only way to verify the password-reset flow end to end without a live
 * SMTP server: the logged line is a real, usable reset link.
 */
@Injectable()
export class MailerService implements OnModuleInit {
  private readonly logger = new Logger('MailerService');
  private transporter: Transporter | undefined;
  private fromAddress!: string;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const host = this.configService.get<string>('smtpRelay.host');
    this.fromAddress = this.configService.get<string>('smtpRelay.from')!;

    if (!host) {
      this.logger.warn(
        'SMTP_RELAY_HOST is not set — outbound email will be logged, not sent. ' +
          'Fine for local dev; set it before this environment needs real delivery.',
      );
      return;
    }

    const user = this.configService.get<string>('smtpRelay.user');
    this.transporter = createTransport({
      host,
      port: this.configService.get<number>('smtpRelay.port'),
      // No credentials = the platform's own Postfix on its internal port
      // (ADR-012), which trusts the API's network instead of a login. An
      // external relay (SES, …) gets user/password.
      ...(user ? { auth: { user, pass: this.configService.get<string>('smtpRelay.password') } } : {}),
    });
  }

  async send(input: SendMailInput): Promise<void> {
    const from = input.from ?? this.fromAddress;

    if (!this.transporter) {
      this.logger.warn(
        `[DEV MODE — not actually sent] From: ${from} | To: ${input.to} | Subject: ${input.subject}\n${input.text}`,
      );
      return;
    }

    await this.transporter.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
  }
}
