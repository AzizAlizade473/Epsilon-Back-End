# Epsilon Admin — design and API contract

Private internal BI and operations dashboard. Two parts, one repo:

- **Admin API**: `src/admin/**` in this Fastify backend, mounted at `/admin/api`.
- **Admin web app**: `admin/` (Vite + React + TypeScript), built to `admin/dist`, served
  as static files on the admin host only.

Production address: `https://admin.epsilonup.com/` (Cloudflare DNS). The admin app and
`/admin/api` are reachable **only** through a Cloudflare Tunnel protected by Cloudflare
Zero Trust Access. They are never served on the public origin (`*.sslip.io`, the EC2 IP,
or port 3000).

## Security model (defense in depth, deny by default)

1. **Gateway**: Cloudflare Access (policy: explicit email allowlist + Google IdP + MFA /
   passkeys) in front of a Cloudflare Tunnel. Every request carries
   `Cf-Access-Jwt-Assertion`.
2. **Server-side Access JWT validation** on every `/admin/api` request: RS256 signature
   against `https://<ADMIN_CF_TEAM_DOMAIN>/cdn-cgi/access/certs` (cached JWKS via `jose`),
   `aud` = `ADMIN_CF_AUD`, `iss` = team domain, `exp`/`nbf`, and `email` + `sub` present.
   Missing or invalid → 401. If `ADMIN_CF_TEAM_DOMAIN`/`ADMIN_CF_AUD` are unset the admin
   API is **disabled** (404) unless development mode below applies.
3. **Origin isolation**: the public listener refuses any request whose path starts with
   `/admin` (404) unless it arrives on the dedicated admin listener (`ADMIN_PORT`, bound to
   127.0.0.1, reached only by `cloudflared`). Caddy never proxies `/admin`.
4. **Admin identity is separate from consumer accounts**: table `admin_users`
   (provisioned only by CLI `npm run admin:add -- <email> <role>`; no registration; no
   default password). The Access JWT `email` must match an `active` admin user; the first
   successful login pins the Access `sub` (identity id) and later logins must match it.
   A consumer session token never grants anything here.
5. **Admin sessions**: `admin_sessions` (token stored as SHA-256), cookie
   `__Host-epsilon_admin` (Secure, HttpOnly, SameSite=Strict, Path=/, no Domain — so it is
   never shared with other epsilonup.com hosts). Idle timeout 30 min, absolute 8 h, new
   token on every login (no fixation), revoked on logout, by `npm run admin:revoke`, or
   when the admin is disabled. Each request must present BOTH a valid Access JWT and a
   valid session belonging to the same admin.
6. **CSRF**: every non-GET request needs header `X-CSRF-Token` equal to the session's
   CSRF secret (returned by `/session` and `/me`), plus SameSite=Strict.
7. **Roles → permissions** (server-side only; roles never read from the client):
   - `super_admin`: everything below + `pii:reveal`, `admins:manage`, `audit:read`
   - `operations`: `analytics:read`, `reviews:moderate`, `restaurants:write`,
     `notifications:draft`, `notifications:test`, `export`
   - `analyst`: `analytics:read`, `export`
   - `partner` (reserved, disabled): rejected everywhere until tenant isolation ships.
8. **Kill switch**: `ADMIN_ENABLED=false` → every `/admin/api` path 404s immediately;
   `npm run admin:revoke -- --all` revokes every admin session.
9. **Data access**: analytics run on a separate `pg` pool using `ADMIN_DATABASE_URL`, a
   Neon role with `SELECT` only (`epsilon_admin_ro`). Writes (moderation, audit, sessions)
   use the main pool through narrow functions. No arbitrary SQL, all queries parameterised,
   every filter validated with zod, all lists paginated (max 100), no unbounded exports
   (max 50 000 rows, audited).
10. **PII**: phones and emails are masked in every response (`+994 55 ••• •• 55`,
    `a•••@gmail.com`). Full values only via `POST /users/:id/reveal` (`pii:reveal`,
    reason required, audited). Never returned anywhere: OTPs, hashes, refresh/push
    tokens, session tokens, raw fiscal QR payloads. Fiscal IDs are masked (first 4 + last 4).
11. **Headers**: `Cache-Control: no-store`, strict CSP for the static app
    (`default-src 'self'`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
    `X-Content-Type-Options: nosniff`, no CORS (same origin only).
12. **Audit log** `admin_audit` (append-only; no update/delete route): admin id, action,
    entity type/id, reason, before/after (JSON, PII-free), outcome, IP, user agent, time.
    Logged: login, logout, reveal, export, moderation, restaurant edits, notification
    test/draft, denied (403) requests.
13. **Rate limits**: 120 req/min per admin; `/session` 10/min per IP.

### Development mode

Only when `NODE_ENV !== 'production'` **and** `ADMIN_DEV_EMAIL` is set **and** the request
comes from 127.0.0.1/::1 on the admin listener: the Access JWT check is replaced by that
identity. Config refuses `ADMIN_DEV_EMAIL` in production.

## API (all JSON, under `/admin/api`, `GET` unless noted)

Common query params (validated): `from`, `to` (ISO dates; reporting time zone
`Asia/Baku`, stored timestamps are UTC), `cursor`, `limit` (1–100, default 25), `sort`,
`q`. Money is integer qəpik (`…Minor`). Every list returns
`{ items, nextCursor }`. Every analytics response includes
`{ generatedAt, tracking?: { <metric>: 'not_tracked' | { since: ISO } } }` so the UI can
show "Not tracked yet" instead of a fake zero.

### Session
- `POST /session` → `{ admin: { id, email, name, role, permissions[] }, csrfToken }` (sets cookie)
- `GET /me` → same shape
- `POST /logout` → 204

### Overview
- `GET /overview?from&to` →
  `{ kpis, previous, series: { days: [{ date, newUsers, activeUsers, receipts, ratings }] }, ratingDistribution: [n1,n2,n3,n4,n5], topRestaurants: [{ key, name, logoBrand, receipts, ratings, avgRating }], activity: [{ type, at, text }] }`
  where `kpis` (and `previous`, same keys, for the preceding equal-length period) =
  `{ totalUsers, newUsers, dau, wau, mau, receiptsImported, uniqueRestaurants, ratings, avgRating, cashbackConfirmedMinor, activePartners, receiptToRatingRate, returningUserPct, avgRatingsPerReceipt }`.

### Users
- `GET /users?q&from&to&sort&cursor&limit` → items `{ id, name, emailMasked, phoneMasked, createdAt, lastActiveAt, receipts, ratings, cashbackMinor, notifications: { reminders, cashbackUpdates, partnerUpdates, pushDevices }, status }`
- `GET /users/:id` → `{ user, receipts[], reviews[], ledger[], notifications[], preferences }`
- `POST /users/:id/reveal` `{ reason }` → `{ email, phone }` (perm `pii:reveal`, audited)
- `GET /users/analytics?from&to` → `{ registrations[], active[], returningUserPct, avgReceiptsPerUser, avgRatingsPerUser, neverScanned, scannedNeverRated, ratedNonPartner, notificationOptInRate, cohorts }`

### Restaurants (every merchant seen on receipts + partners)
Merchant key: `r:<restaurantId>` for partners, `m:<establishment objectCode>` for
non-partner fiscal merchants (never merged by similar names).
- `GET /restaurants?q&partner&sort&cursor&limit` → items `{ key, name, chain, branch, category, voenMasked, objectCode, isPartner, receipts, reviewers, ratings, avgRating, lastActivityAt }`
- `GET /restaurants/:key?from&to` → `{ restaurant, kpis, distribution, trend[], dishes[], best[], needsAttention[], dimensions, reviews[] }`
- `PATCH /restaurants/:key` (perm `restaurants:write`, audited) — metadata only (display name, logoUrl); partnership changes are out of scope for now.

### Dishes (key = merchant key + normalised dish name)
- `GET /dishes?q&restaurant&minRatings&sort&cursor&limit` → items `{ key, name, restaurant, branch, purchases, ratings, avgRating, distribution, positivePct, negativePct, lastRatedAt }`
- `GET /dishes/:key?from&to` → `{ dish, kpis, distribution, trend[], dimensions: { <dimension>: { positive, neutral, negative } }, reviews[] }`
  Rankings require `minRatings` (default 3); sample size is always returned.

### Reviews
- `GET /reviews?restaurant&dish&user&stars&from&to&dimension&sentiment&hasComment&edited&moderated&cursor&limit` → items `{ id, restaurant, dish, reviewer, rating, quickComments[], comment, createdAt, updatedAt, edited, moderation }`
- `GET /reviews/:id` → review + receipt/dish context
- `POST /reviews/:id/moderate` `{ hidden: boolean, reason }` (perm `reviews:moderate`, audited; reversible; hidden reviews are excluded from aggregates and from public lists; the text is never altered)

### Likes
- `GET /likes/stats?from&to` → `{ counts: { dish, review, restaurant }, top: { dish[], review[], restaurant[] } }` (top 10 with `count`; deleted accounts excluded)
- `GET /likes?kind&from&to&cursor&limit` → items `{ id, kind, targetId, restaurantId, dishId, title, subtitle, createdAt, user (masked) }`; `GET /users/:id` adds `likes` counts

### Receipts
- `GET /receipts?status&category&from&to&cursor&limit` → items `{ id, fiscalIdMasked, restaurant, category, importedAt, totalMinor, items, status, ratings, cashbackEligible, provider, engine }`
- `GET /receipts/:id` → merchant, lines (original names, qty, price), engine, related reviews and ledger
- `GET /receipts/health?from&to` → `{ imported, byProvider, byEngine, unsupported, unknownMerchant, failures: 'not_tracked' | {...} }`

### Cashback
- `GET /cashback?from&to` → `{ confirmedMinor, pendingMinor, reversedMinor, expiredMinor, liabilityMinor, byRestaurant[], byDay[] }`
- `GET /cashback/ledger?type&status&user&restaurant&from&to&cursor&limit`

### Notifications
- `GET /notifications/stats?from&to` → `{ sent, read, byKind[], optIn: { reminders, cashbackUpdates, partnerUpdates }, devices, delivery: 'not_tracked' }`
- `GET /notifications?kind&from&to&cursor&limit` → history (titles, kind, created, read state; no tokens)

### Costs, health, audit, search, export
- `GET /costs?from&to` → `{ gemini: { calls, byDay[], estimate: { minor, basis } } , email: 'not_tracked', push: 'not_tracked' }` (estimates labelled as estimates)
- `GET /health` → `{ api: { uptimeS, version }, db: { ok, latencyMs }, jobs: { mealReminders: { lastRunAt } } }`
- `GET /audit?admin&action&from&to&cursor&limit` (perm `audit:read`)
- `GET /search?q` → `{ users[], restaurants[], dishes[], reviews[], receipts[] }` (masked, ≤5 each)
- `GET /export/:report.csv?…` (perm `export`, audited, ≤50 000 rows, formula-injection
  safe: cells starting with `= + - @ \t \r` are prefixed with `'`)

## Metric definitions (shown in the UI as tooltips)

- **Total users**: `users` rows not deleted. **New users**: created in range.
- **Active user (day)**: a user who, that Baku day, signed in or refreshed a session,
  claimed a receipt, or submitted/edited a review. DAU/WAU/MAU use the last 1/7/30 days
  ending at `to`.
- **Receipts imported**: claimed purchases (`purchases` with `claimed_by`), counted once
  per purchase; unique fiscal receipts are counted separately.
- **Unique restaurants**: distinct merchant keys with ≥1 imported receipt.
- **Ratings**: `feedback` rows (an edit does not add a rating); hidden (moderated) excluded.
- **Avg rating**: mean of current ratings in range.
- **Receipt-to-rating rate**: imported receipts with ≥1 rating ÷ imported receipts.
- **Returning user %**: users with ≥2 distinct active days in range ÷ active users.
- **Observed purchase value**: sum of receipt totals seen through Epsilon (never called
  revenue).
- **Cashback confirmed**: `ledger_entries` type `earned`, status `confirmed`.
  Demo/test data (fixture provider receipts) is excluded everywhere.

## Configuration

`ADMIN_ENABLED`, `ADMIN_PORT` (default 3100, 127.0.0.1), `ADMIN_DATABASE_URL`
(read-only role), `ADMIN_CF_TEAM_DOMAIN` (e.g. `epsilon.cloudflareaccess.com`),
`ADMIN_CF_AUD`, `ADMIN_DEV_EMAIL` (development only).
