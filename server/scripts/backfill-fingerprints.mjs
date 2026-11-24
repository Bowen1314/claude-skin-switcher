#!/usr/bin/env node
// Fill in the fingerprint of skins uploaded before migration 0003.
//
// Calls POST /api/admin/fingerprints page by page until no page is left; the
// Worker computes each fingerprint with shared/fingerprint.js, exactly as on
// upload. Safe to run more than once: only rows without a fingerprint change.
//
//   node server/scripts/backfill-fingerprints.mjs [--base https://...] [--env <file>] [--batch 5] [--dry-run]
//
// The env file (default ~/.config/claude-theme-switcher/server.env) holds
// ADMIN_TOKEN=... and BASE_URL=...; --base overrides BASE_URL. Prints counts only.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

function parseArgs(argv) {
  const out = { env: join(homedir(), '.config/claude-theme-switcher/server.env'), base: null, batch: 5, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--env') out.env = resolve(argv[++i]);
    else if (a === '--batch') out.batch = Number(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(out.batch) || out.batch < 1 || out.batch > 50) throw new Error('--batch must be 1 to 50');
  return out;
}

function readEnvFile(path) {
  const vars = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envVars = readEnvFile(args.env);
  const base = (args.base || envVars.BASE_URL || '').replace(/\/+$/, '');
  const token = envVars.ADMIN_TOKEN || process.env.ADMIN_TOKEN || '';
  if (!base) throw new Error('no base URL: pass --base or set BASE_URL in the env file');
  if (!token) throw new Error('no ADMIN_TOKEN in the env file');

  let after = null;
  let updated = 0;
  let computed = 0;
  let remaining = null;
  const failed = [];
  for (let page = 0; page < 10000; page++) {
    const res = await fetch(`${base}/api/admin/fingerprints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
      body: JSON.stringify({ limit: args.batch, after, dryRun: args.dryRun }),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      console.log(`backfill: ${res.status} ${data?.error ?? ''}`);
      return 1;
    }
    updated += data.updated;
    computed += data.computed;
    failed.push(...data.failed);
    remaining = data.remaining;
    if (data.next === null) break;
    after = data.next;
  }
  console.log(args.dryRun ? `dry run: ${computed} fingerprints computed, nothing written` : `updated ${updated} skins`);
  for (const ref of failed) console.log(`  could not read ${ref}`);
  console.log(`still without a fingerprint: ${remaining}`);
  return failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`backfill-fingerprints: ${err.message}`);
    process.exit(1);
  },
);
