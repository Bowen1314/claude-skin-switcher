import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { handle } from '../src/handler.js';
import { FakeD1 } from './fake-d1.js';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/seed-official.mjs', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/skins', import.meta.url));
const pluginSkins = fileURLToPath(new URL('../../plugin/skins', import.meta.url));

test('seed-official PUTs fixture skins through the admin endpoint', async () => {
  const env = { DB: new FakeD1(), ADMIN_TOKEN: 'z'.repeat(64), IP_SALT: 'y'.repeat(64) };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'seed-test-'));
  const envFile = join(dir, 'server.env');
  writeFileSync(envFile, `ADMIN_TOKEN=${env.ADMIN_TOKEN}\nBASE_URL=${base}\n`);
  try {
    const first = await run(process.execPath, [script, '--dir', fixtures, '--env', envFile]);
    assert.match(first.stdout, /official\.fixture-skin: 201 version 1/);
    assert.ok(!first.stdout.includes(env.ADMIN_TOKEN));
    const second = await run(process.execPath, [script, '--dir', fixtures, '--env', envFile]);
    assert.match(second.stdout, /official\.fixture-skin: 200 version 2/);
    const got = await (await fetch(`${base}/api/skins/official/fixture-skin`)).json();
    assert.equal(got.author, 'official');
    assert.equal(got.version, 2);
    const svg = await fetch(`${base}/api/skins/official/fixture-skin/scene.svg`);
    assert.equal(svg.status, 200);

    // Wrong token: the script exits non-zero and reports the status.
    writeFileSync(envFile, `ADMIN_TOKEN=${'w'.repeat(64)}\nBASE_URL=${base}\n`);
    await assert.rejects(run(process.execPath, [script, '--dir', fixtures, '--env', envFile]), (err) => /403/.test(err.stdout));
  } finally {
    server.close();
  }
});

test('seed-official dry run validates the real official skins', async () => {
  const r = await run(process.execPath, [script, '--dir', pluginSkins, '--dry-run', '--env', '/nonexistent']);
  assert.match(r.stdout, /valid \(dry run/);
  assert.doesNotMatch(r.stdout, /INVALID/);
});
