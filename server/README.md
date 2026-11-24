# claude-skins: the public skin gallery

A Cloudflare Worker (`claude-skins`) with one D1 database (`claude-skins`). It stores skins in the format of
[`docs/skin-format.md`](../docs/skin-format.md) and validates every upload with
[`shared/skin-validate.js`](../shared/skin-validate.js), the same validator the app uses.

Live: <https://claude-skins.sdigasyugfyasfgdyf.workers.dev>. Free tier only (Workers Free + D1 Free).

## Endpoints

All responses are JSON unless noted. Errors are `{ "error": "..." }` (validation errors add `errors: string[]`).
GET responses carry `Access-Control-Allow-Origin: *`. A ref is `<author>.<slug>`; authors are lower-cased GitHub logins,
or `official` for the built-ins.

| Method & path | Auth | Notes |
| --- | --- | --- |
| `GET /` | none | Small HTML page. |
| `GET /api/health` | none | `{ ok: true }` |
| `GET /api/skins?sort=new\|popular&q=&tag=&cursor=&limit=` | none | `limit` 1–50 (default 24). Hidden skins are left out. `new` sorts by `updated_at`, `popular` by `downloads`. Returns `{ items, nextCursor }`; pass `nextCursor` back as `cursor` (with the same `sort`). Each item: `ref, author, slug, name, description, tags, version, downloads, hasScene, updatedAt, preview: { dark?, light? }` where a preview is `{ surface0, surface1, text, muted, accent }` (only modes the skin defines). |
| `GET /api/skins/:author/:slug` | none | The normalized skin plus `author` and `version`. 404 if hidden. |
| `GET /api/skins/:author/:slug/scene.svg` | none | `image/svg+xml`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`. |
| `POST /api/skins/:author/:slug/download` | none | Counts a download once per salted IP hash per skin per UTC day. `{ ok, counted, downloads }` |
| `POST /api/skins/:author/:slug/report` | none | One report per salted IP hash. At 3 distinct reports the skin is hidden. `{ ok, counted, hidden }` |
| `POST /api/skins` | GitHub | Body `{ skin, scene? }`, at most 300 KB. The author is the caller's login; `author`/`version` in the body are ignored. Creates (201) or bumps the version (200): `{ ref, version }`. At most 10 uploads per login per 24 h (429). `scene` is required when `backdrop.scene` is true and refused otherwise. The login `official` is reserved. |
| `DELETE /api/skins/:author/:slug` | GitHub | Owner only. |
| `GET /api/me` | GitHub | `{ login, skins }`, including hidden skins (`hidden`, `reports`). |
| `PUT /api/admin/skins/:author/:slug` | admin | Body `{ skin, scene? }`; `author` may be `official`; `skin.slug` must match the URL. Not rate limited. |
| `DELETE /api/admin/skins/:author/:slug` | admin | |
| `POST /api/admin/skins/:author/:slug/unhide` | admin | Clears the hidden flag and all reports. |
| `POST /api/admin/bans` | admin | Body `{ login, reason? }`. Banned logins get 403 on every authenticated call; their skins are hidden. |

**GitHub auth:** `Authorization: Bearer <GitHub OAuth token>`. The Worker resolves the login with
`GET https://api.github.com/user` and caches `sha256(token) -> login` for one hour in `token_cache`. Raw tokens are
never stored or logged. A token GitHub rejects gives 401; a GitHub outage gives 502.

**Admin auth:** header `X-Admin-Token` equal to the `ADMIN_TOKEN` secret. If the secret is missing or shorter than
32 characters, admin calls are refused.

IP addresses are never stored: reports and download dedupe use `sha256(IP_SALT + ":" + CF-Connecting-IP)`.

## Layout

```
server/
  wrangler.toml            Worker + D1 binding (DB)
  src/index.js             Worker entry
  src/handler.js           handle(request, env, deps): all routes
  migrations/0001_init.sql schema
  scripts/seed-official.mjs
  test/                    node:test suites (fake D1 on node:sqlite, stubbed GitHub)
```

## Test

```sh
cd server && node --test test/*.test.js     # Node 22.5+ (uses node:sqlite)
cd shared && node --test test/*.test.js
```

## Deploy from scratch

```sh
cd server
npx wrangler login
npx wrangler d1 create claude-skins          # put the database_id into wrangler.toml
npx wrangler d1 migrations apply claude-skins --remote
npx wrangler deploy
# secrets: see below
node scripts/seed-official.mjs               # upload plugin/skins/official.* (validated first)
```

Schema changes go in a new `migrations/000N_*.sql`, then `npx wrangler d1 migrations apply claude-skins --remote`.

## Secrets

Both live in `~/.config/claude-theme-switcher/server.env` (mode 600) as `ADMIN_TOKEN=`, `IP_SALT=` and `BASE_URL=`,
and in the Worker as secrets. Rotate without printing them:

```sh
F=~/.config/claude-theme-switcher/server.env
NEW=$(openssl rand -hex 32)
sed -i '' "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$NEW/" "$F"     # GNU sed: sed -i
printf %s "$NEW" | npx wrangler secret put ADMIN_TOKEN
unset NEW
```

Same for `IP_SALT`. Rotating `IP_SALT` resets report and download dedupe (old hashes no longer match); existing
report counts and hidden flags stay.

## Moderation by hand

```sh
npx wrangler d1 execute claude-skins --remote --command "SELECT author, slug, reports, hidden FROM skins WHERE reports > 0"
npx wrangler d1 execute claude-skins --remote --command "DELETE FROM bans WHERE login = 'someone'"   # unban
```

Not affiliated with Anthropic.
