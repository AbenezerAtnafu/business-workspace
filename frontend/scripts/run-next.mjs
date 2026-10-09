#!/usr/bin/env node
// `npm run dev` / `npm start` → `next dev|start -p <WEB_PORT>`.
//
// Next.js can't take its port from .env files: the HTTP server is bound
// before Next loads them. This wrapper reads WEB_PORT itself, with the same
// precedence Next uses for everything else: the shell environment, then
// .env.local, then .env. The default is 3001. docker compose reads WEB_PORT
// from the same .env for the host port, so one line sets both.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [command = 'dev', ...rest] = process.argv.slice(2);

function fromEnvFile(file, key) {
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === key) return m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

const port =
  process.env.WEB_PORT ||
  fromEnvFile('.env.local', 'WEB_PORT') ||
  fromEnvFile('.env', 'WEB_PORT') ||
  '3001';

if (!/^\d+$/.test(port)) {
  console.error(`WEB_PORT must be a number, got "${port}"`);
  process.exit(1);
}

const next = path.join('node_modules', '.bin', process.platform === 'win32' ? 'next.cmd' : 'next');
const child = spawn(next, [command, '-p', port, ...rest], { stdio: 'inherit', shell: process.platform === 'win32' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
