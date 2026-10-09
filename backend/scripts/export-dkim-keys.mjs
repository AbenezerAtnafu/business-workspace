#!/usr/bin/env node
// Export each verified domain's DKIM private key to the signer's key directory
// (Rspamd: <dir>/<domain>.<selector>.key + <dir>/selectors.map). ADR-012.
//
//   node scripts/export-dkim-keys.mjs --out /var/lib/rspamd/dkim            # once
//   node scripts/export-dkim-keys.mjs --out /var/lib/rspamd/dkim --watch 60  # loop
//
// Keys are stored encrypted (AES-256-GCM, EncryptionService) in
// control.domains.dkim_private_key; this is the one place they are decrypted
// outside the API, so it needs ENCRYPTION_KEY. It connects as the
// `dkim_exporter` role (migration 015), which can read exactly one view,
// mail.dkim_keys — verified domains of active orgs, encrypted keys only.
//
// Files are written atomically (temp + rename) with mode 0640. Keys of domains
// that are no longer verified, or were removed, are deleted, so a removed
// domain stops being signed for on the next pass.
import 'dotenv/config';
import { createDecipheriv, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const OUT = arg('--out', process.env.DKIM_KEY_DIR ?? '/var/lib/rspamd/dkim');
const WATCH = Number(arg('--watch', '0'));
const DB_URL = process.env.DKIM_EXPORT_DATABASE_URL;
const KEY = createHash('sha256').update(process.env.ENCRYPTION_KEY ?? '').digest();

if (!DB_URL) {
  console.error('export-dkim-keys: set DKIM_EXPORT_DATABASE_URL (role dkim_exporter, migration 015)');
  process.exit(1);
}
if (!process.env.ENCRYPTION_KEY) {
  console.error('export-dkim-keys: ENCRYPTION_KEY is not set — keys cannot be decrypted');
  process.exit(1);
}

function decrypt(stored) {
  const [iv, tag, data] = stored.split('.').map((b) => Buffer.from(b, 'base64'));
  const d = createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

function writeAtomic(file, content, mode = 0o640) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

async function exportOnce() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT domain_name AS domain, selector, encrypted_private_key AS key FROM mail.dkim_keys ORDER BY 1',
    );
    fs.mkdirSync(OUT, { recursive: true });
    const keep = new Set(['selectors.map']);
    const map = [];
    let failed = 0;
    for (const r of rows) {
      // A domain/selector is only ever [a-z0-9.-]; refuse anything else as a path.
      if (!/^[a-z0-9.-]+$/.test(r.domain) || !/^[a-z0-9-]+$/i.test(r.selector)) {
        console.error(`export-dkim-keys: skipping unsafe name ${r.domain}/${r.selector}`);
        continue;
      }
      let pem;
      try {
        pem = decrypt(r.key);
      } catch {
        failed++;
        console.error(`export-dkim-keys: cannot decrypt key for ${r.domain} (wrong ENCRYPTION_KEY?)`);
        continue;
      }
      const name = `${r.domain}.${r.selector}.key`;
      writeAtomic(path.join(OUT, name), pem);
      keep.add(name);
      map.push(`${r.domain} ${r.selector}`);
    }
    writeAtomic(path.join(OUT, 'selectors.map'), map.join('\n') + (map.length ? '\n' : ''), 0o644);
    let removed = 0;
    for (const f of fs.readdirSync(OUT)) {
      if (f.endsWith('.key') && !keep.has(f)) {
        fs.unlinkSync(path.join(OUT, f));
        removed++;
      }
    }
    console.log(`export-dkim-keys: ${map.length} key(s) in ${OUT}${removed ? `, removed ${removed}` : ''}${failed ? `, ${failed} failed` : ''}`);
    return failed;
  } finally {
    await client.end();
  }
}

if (WATCH > 0) {
  // Loop forever; a failed pass is logged and retried, never fatal.
  for (;;) {
    try {
      await exportOnce();
    } catch (err) {
      console.error(`export-dkim-keys: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, WATCH * 1000));
  }
} else {
  process.exit((await exportOnce()) ? 1 : 0);
}
