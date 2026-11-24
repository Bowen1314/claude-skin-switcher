# claude-skins: the public skin gallery

A Cloudflare Worker (`claude-skins`) with one D1 database (`claude-skins`). It stores skins in the format of
[`docs/skin-format.md`](../docs/skin-format.md) and validates every upload with
[`shared/skin-validate.js`](../shared/skin-validate.js), the same validator the app uses.

Live: <https://claude-skins.sdigasyugfyasfgdyf.workers.dev>. Free tier only (Workers Free + D1 Free).

## Endpoints

All responses are JSON unless noted. Errors are `{ "error": "..." }` (validation errors add `errors: string[]`).
GET responses carry `Access-Control-Allow-Origin: *`. A ref is `<author>.<slug>`; the author is the uploader's handle
(see below), or `official` for the built-ins.

| Method & path | Auth | Notes |
| --- | --- | --- |
| `GET /`, `GET /privacy`, `GET /terms` | none | 301 to the website: <https://bowen1314.github.io/claude-skin-switcher/>, `…/privacy.html`, `…/terms.html`. `HEAD` too. |
| `GET /api/health` | none | `{ ok: true }` |
| `GET /api/skins?sort=new\|popular&q=&tag=&cursor=&limit=` | none | `limit` 1–50 (default 24). Hidden skins are left out. `new` sorts by `updated_at`, `popular` by `downloads`. Returns `{ items, nextCursor }`; pass `nextCursor` back as `cursor` (with the same `sort`). Each item: `ref, author, slug, name, description, tags, version, downloads, hasScene, updatedAt, preview: { dark?, light? }` where a preview is `{ surface0, surface1, text, muted, accent }` (only modes the skin defines). A declared remix adds `basedOn` (`"<author>.<slug>"`) and `basedOnName` (the original's name, `null` once it is hidden or deleted). |
| `GET /api/skins/:author/:slug` | none | The normalized skin plus `author` and `version` (and `basedOn`, `basedOnName` for a remix). 404 if hidden. |
| `GET /api/skins/:author/:slug/scene.svg` | none | `image/svg+xml`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'`, `X-Content-Type-Options: nosniff`. |
| `POST /api/skins/:author/:slug/download` | none | Counts a download once per salted IP hash per skin per UTC day. `{ ok, counted, downloads }` |
| `POST /api/skins/:author/:slug/report` | none | One report per salted IP hash. At 3 distinct reports the skin is hidden. `{ ok, counted, hidden }` |
| `POST /api/skins` | Google | Body `{ skin, scene?, basedOn? }`, at most 300 KB. Needs a handle first (409 `no handle`). The author is the caller's handle; `author`/`version` in the body are ignored. Creates (201) or bumps the version (200): `{ ref, version }`. At most 10 uploads per account per 24 h (429). `scene` is required when `backdrop.scene` is true and refused otherwise. If another author's skin, hidden or not, has the same fingerprint (see below): 409 `{ error: "already in the gallery", original: "<author>.<slug>", name }`, naming the oldest one; nothing is stored and the upload doesn't count toward the daily limit. `basedOn: "<author>.<slug>"` declares a remix: a match is allowed when `basedOn` names one of the skins that hold the fingerprint (400 if it isn't a ref). It is stored and listed if that skin exists; a new version without `basedOn` keeps the one it had. |
| `DELETE /api/skins/:author/:slug` | Google | Owner only (`:author` must be the caller's handle), else 403. |
| `GET /api/me` | Google | `{ handle: string \| null, skins }`. `skins` is `[]` until a handle is claimed; it includes hidden skins (`hidden`, `reports`). |
| `POST /api/me/handle` | Google | Body `{ handle }` (trimmed, lower-cased). Returns `{ handle }` with 200. 400 if it doesn't match `^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$`; 409 `handle reserved`, 409 `handle taken`, 409 `handle locked` (the account already has skins; delete them to change it); 429 after 10 changes per 24 h. Claiming the current handle again is a no-op 200. |
| `PUT /api/admin/skins/:author/:slug` | admin | Body `{ skin, scene?, basedOn? }`; `author` may be `official`; `skin.slug` must match the URL. Stores the fingerprint; no copy check. Not rate limited. |
| `DELETE /api/admin/skins/:author/:slug` | admin | |
| `POST /api/admin/skins/:author/:slug/unhide` | admin | Clears the hidden flag and all reports. |
| `POST /api/admin/fingerprints` | admin | Body `{ limit?, after?, dryRun? }`. Computes the fingerprint of up to `limit` (1–50, default 5) skins that have none, in `(author, slug)` order after `after` (`"<author>.<slug>"`). Returns `{ ok, dryRun, updated, computed, failed, next, remaining }`; pass `next` back as `after` until it is `null`. `failed` lists rows whose stored skin can't be read. Used by the backfill script. |
| `POST /api/admin/bans` | admin | Body `{ handle, reason? }` or `{ sub_hash, reason? }`. Returns `{ ok, subHash, handle, hiddenSkins }`. Banned accounts get 403 on every authenticated call; their skins are hidden. 404 if no account has the handle. |

**Google sign-in:** `Authorization: Bearer <Google ID token>` (the app asks for the `openid` scope only). The Worker
verifies the RS256 signature against Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`, cached by `kid` for
the response's `max-age`, refetched on an unknown `kid` at most once a minute), and checks `iss` is
`accounts.google.com` or `https://accounts.google.com`, `aud` equals `GOOGLE_CLIENT_ID`, `exp` has not passed and `iat`
is not in the future (60 s leeway). The account id is `HMAC-SHA256(key = IP_SALT, sub)` in hex (`sub_hash`); the raw
`sub` is never stored, and email or name are never requested, stored or logged.

Order of checks: no `Authorization` header or a malformed token gives 401; then, if `GOOGLE_CLIENT_ID` is empty, 503
`sign-in not configured`; then a bad signature, issuer, audience or time gives 401; a JWKS outage gives 502; a banned
account gives 403.

**Handles:** the public author name. Reserved: `official`, `default`, `local`, `admin`, `root`, `support`, `anthropic`,
`claude`, `gallery`, `api`, and anything starting with `official`. A name already used as an author by an
admin-placed skin also counts as taken.

**Admin auth:** header `X-Admin-Token` equal to the `ADMIN_TOKEN` secret. If the secret is missing or shorter than
32 characters, admin calls are refused.

IP addresses are never stored: reports and download dedupe use `sha256(IP_SALT + ":" + CF-Connecting-IP)`.

**Fingerprints:** `skinFingerprint(skin, scene)` in [`shared/fingerprint.js`](../shared/fingerprint.js), the same code
the app runs before an upload, is the sha256 hex of what a skin draws. With a scene: the scene with comments and all
whitespace removed, every color literal (`#hex`, `rgb()`/`hsl()`/… calls, named colors, `transparent`,
`currentColor`) replaced by one placeholder, and `var(--v-*, fallback)` reduced to `var(--v-*)`, so recoloring, renaming or
reformatting keeps it and changing a shape, a number or a variable name changes it. Without a scene the colors are
the design and stay in: the validated skin minus `name`, `description`, `tags`, `slug`, `author` and `version`, keys
sorted, hex colors lower-cased. So a palette-only skin matches only an identical one apart from those fields.

## Layout

```
server/
  wrangler.toml            Worker + D1 binding (DB)
  src/index.js             Worker entry
  src/handler.js           handle(request, env, deps): all routes
  migrations/0001_init.sql schema
  migrations/0002_google_accounts.sql  Google accounts and handles (drops the GitHub token cache)
  migrations/0003_fingerprints.sql     fingerprint and based_on columns
  scripts/seed-official.mjs
  scripts/backfill-fingerprints.mjs
  test/                    node:test suites (fake D1 on node:sqlite, test RSA keys + stubbed Google JWKS)
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

## Backfill fingerprints

Skins uploaded before `0003_fingerprints.sql` have no fingerprint, so copies of them aren't caught until it is filled
in. Order matters: apply the migration first, then deploy (the new Worker reads the `based_on` column, so listing
fails on a database without it), then backfill:

```sh
cd server
node scripts/backfill-fingerprints.mjs --dry-run      # counts only, writes nothing
node scripts/backfill-fingerprints.mjs                # fills them in, 5 per request
npx wrangler d1 execute claude-skins --remote --command "SELECT COUNT(*) FROM skins WHERE fingerprint IS NULL"
```

It reads `ADMIN_TOKEN` and `BASE_URL` from `~/.config/claude-theme-switcher/server.env` (`--env <file>`, `--base <url>`
and `--batch <1-50>` override) and prints counts only. A fingerprint of a large scene costs a few ms of CPU; if a page fails with error 1102 (CPU
limit), run it again with `--batch 1`. Running it again is safe: only rows without a fingerprint
change. A row listed as "could not read" keeps a `NULL` fingerprint; fix or delete that skin by hand.

## Secrets

Both live in `~/.config/claude-theme-switcher/server.env` (mode 600) as `ADMIN_TOKEN=`, `IP_SALT=` and `BASE_URL=`,
and in the Worker as secrets. `GOOGLE_CLIENT_ID` is not a secret: it is a `[vars]` entry in `wrangler.toml`; set it and
`npx wrangler deploy`. Rotate without printing them:

```sh
F=~/.config/claude-theme-switcher/server.env
NEW=$(openssl rand -hex 32)
sed -i '' "s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$NEW/" "$F"     # GNU sed: sed -i
printf %s "$NEW" | npx wrangler secret put ADMIN_TOKEN
unset NEW
```

**Do not rotate `IP_SALT`** once people have signed in: it is the HMAC key for account ids, so a new value orphans
every account (handles, bans and ownership of skins stop matching). It also resets report and download dedupe.

## Moderation by hand

```sh
npx wrangler d1 execute claude-skins --remote --command "SELECT author, slug, reports, hidden FROM skins WHERE reports > 0"
npx wrangler d1 execute claude-skins --remote --command "DELETE FROM bans WHERE sub_hash = (SELECT sub_hash FROM accounts WHERE handle = 'someone')"   # unban (skins stay hidden; unhide them one by one)
```

Not affiliated with Anthropic.
