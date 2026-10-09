import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * App-layer envelope encryption for the columns architecture/data-model.md
 * marks "encrypted at rest": tenant.users.mfa_secret (this slice) and,
 * later, control.domains.dkim_private_key (Step 2.2) — same algorithm,
 * same key, reused rather than re-implemented when that second column
 * arrives.
 *
 * AES-256-GCM: authenticated encryption, so a tampered ciphertext fails
 * to decrypt rather than silently returning garbage. The configured
 * ENCRYPTION_KEY can be any string (a passphrase, not necessarily 32
 * bytes) — it's hashed with sha256 to derive a proper 256-bit key, so
 * there's no awkward "must be exactly N bytes, base64-encoded" operational
 * requirement for whoever sets that env var.
 */
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const configuredKey = configService.get<string>('encryptionKey') ?? '';
    this.key = createHash('sha256').update(configuredKey).digest();
  }

  /** Returns `${iv}.${authTag}.${ciphertext}`, each base64, in one string column-storable value. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv, authTag, ciphertext].map((buf) => buf.toString('base64')).join('.');
  }

  decrypt(stored: string): string {
    const [ivB64, authTagB64, ciphertextB64] = stored.split('.');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
