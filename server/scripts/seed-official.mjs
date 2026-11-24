#!/usr/bin/env node
// Seed (or refresh) the official skins in the live gallery.
//
// Reads <dir>/official.<slug>/skin.json (+ scene.svg) and PUTs each through
// PUT /api/admin/skins/official/<slug>. Every skin is validated locally first.
//
//   node server/scripts/seed-official.mjs [--dir plugin/skins] [--base https://...] [--env <file>] [--dry-run]
//
// The env file (default ~/.config/claude-theme-switcher/server.env) holds
// ADMIN_TOKEN=... and BASE_URL=...; --base overrides BASE_URL. Prints statuses only.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { validateSkin, validateScene } from '../../shared/skin-validate.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

function parseArgs(argv) {
  const out = { dir: join(projectRoot, 'plugin/skins'), env: join(homedir(), '.config/claude-theme-switcher/server.env'), base: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = resolve(argv[++i]);
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--env') out.env = resolve(argv[++i]);
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
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

function collect(dir) {
  if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`);
  const skins = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith('official.')) continue;
    const folder = join(dir, name);
    if (!statSync(folder).isDirectory()) continue;
    const slug = name.slice('official.'.length);
    const skinPath = join(folder, 'skin.json');
    if (!existsSync(skinPath)) {
      skins.push({ slug, problems: ['skin.json is missing'] });
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(skinPath, 'utf8'));
    } catch (err) {
      skins.push({ slug, problems: [`skin.json is not JSON: ${err.message}`] });
      continue;
    }
    const scenePath = join(folder, 'scene.svg');
    const scene = existsSync(scenePath) ? readFileSync(scenePath, 'utf8') : undefined;
    const problems = [];
    const v = validateSkin(raw);
    if (!v.ok) problems.push(...v.errors);
    else if (v.skin.slug !== slug) problems.push(`$.slug is "${v.skin.slug}" but the folder says "${slug}"`);
    if (scene !== undefined) {
      const s = validateScene(scene);
      if (!s.ok) problems.push(...s.errors);
    }
    const wantsScene = v.ok && v.skin.backdrop?.scene === true;
    if (v.ok && wantsScene && scene === undefined) problems.push('backdrop.scene is true but scene.svg is missing');
    if (v.ok && !wantsScene && scene !== undefined) problems.push('scene.svg exists but backdrop.scene is not true');
    skins.push({ slug, problems, body: { skin: raw, ...(scene !== undefined ? { scene } : {}) } });
  }
  return skins;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envVars = readEnvFile(args.env);
  const base = (args.base || envVars.BASE_URL || '').replace(/\/+$/, '');
  const token = envVars.ADMIN_TOKEN || process.env.ADMIN_TOKEN || '';

  const skins = collect(args.dir);
  if (skins.length === 0) {
    console.log(`no official.* skins under ${args.dir}`);
    return 1;
  }
  let failed = 0;
  for (const s of skins) {
    if (s.problems.length) {
      failed++;
      console.log(`official.${s.slug}: INVALID`);
      for (const p of s.problems) console.log(`  - ${p}`);
    }
  }
  if (failed) return 1;
  if (args.dryRun) {
    for (const s of skins) console.log(`official.${s.slug}: valid (dry run, not uploaded)`);
    return 0;
  }
  if (!base) throw new Error('no base URL: pass --base or set BASE_URL in the env file');
  if (!token) throw new Error('no ADMIN_TOKEN in the env file');

  for (const s of skins) {
    const res = await fetch(`${base}/api/admin/skins/official/${encodeURIComponent(s.slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
      body: JSON.stringify(s.body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.ok) {
      console.log(`official.${s.slug}: ${res.status} version ${data?.version}`);
    } else {
      failed++;
      console.log(`official.${s.slug}: ${res.status} ${data?.error ?? ''}`);
      for (const e of data?.errors ?? []) console.log(`  - ${e}`);
    }
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`seed-official: ${err.message}`);
    process.exit(1);
  },
);
