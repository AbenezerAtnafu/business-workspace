import { Injectable } from '@nestjs/common';
import { generate, generateSecret, generateURI, verify } from 'otplib';

// Shown as the "issuer" in the user's authenticator app, alongside their
// email — planning/screen-flow-inventory.md §2.11: "Setup screen shows QR +
// manual entry key."
const ISSUER = 'Business Workspace Platform';

/**
 * Thin wrapper around otplib's functional API (TOTP, RFC 6238 — planning/
 * business-rules-and-defaults.md: "MFA: TOTP-based, optional per user in
 * MVP"). Kept separate from AuthService so the otplib API surface — it
 * rewrote its API entirely between major versions — is isolated to one
 * file.
 *
 * The backend returns the otpauth:// URI, not a rendered QR image: standard
 * split of responsibility — the frontend renders the QR client-side (e.g.
 * with a small JS QR library) from this URI, so the backend doesn't need
 * an image-generation dependency for something purely presentational.
 */
@Injectable()
export class MfaService {
  generateSecret(): string {
    return generateSecret();
  }

  buildOtpauthUri(accountEmail: string, secret: string): string {
    return generateURI({ issuer: ISSUER, label: accountEmail, secret });
  }

  async generateCode(secret: string): Promise<string> {
    return generate({ secret });
  }

  async verifyCode(secret: string, code: string): Promise<boolean> {
    const result = await verify({ secret, token: code });
    return result.valid;
  }
}
