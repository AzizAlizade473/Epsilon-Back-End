# Epsilon Back End

The API for the Epsilon mobile app. It stores accounts, logins, profiles,
receipts, ratings, the wallet ledger, restaurants and menus in PostgreSQL. It
serves the `/v1` API that the app calls when `EXPO_PUBLIC_API_MODE=live`.

| Part         | Tech                                                         |
| ------------ | ------------------------------------------------------------ |
| HTTP server  | Node.js 22, TypeScript, Fastify                              |
| Validation   | Zod. Every body, query and path parameter is checked; unknown fields are rejected |
| Database     | PostgreSQL, Drizzle ORM, SQL migrations in `drizzle/`        |
| Auth         | Phone OTP (HMAC-hashed codes), Google ID-token check, JWT access tokens and rotating refresh tokens (stored as SHA-256 hashes) |
| Tests        | Vitest with PGlite, an in-process Postgres, so tests need no database install |

## Run it locally

### 1. Install PostgreSQL (one time)

1. Download the PostgreSQL 17 Windows installer from https://www.postgresql.org/download/windows/.
2. Run it with the defaults. Choose a password for the `postgres` user, and remember it. Keep port 5432.
3. Open **SQL Shell (psql)** from the Start menu. Press Enter on each prompt, type your password, then run:

   ```sql
   CREATE DATABASE epsilon;
   ```

### 2. Configure

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- Put your password into `DATABASE_URL`.
- Fill `JWT_SECRET` and `OTP_SECRET` with two different random values. Generate each one with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```

### 3. Create the tables, add demo data and start

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

Check that it runs: open http://localhost:3000/health and expect `{"status":"ok"}`.

The seed adds three fictional restaurants with branches and menus, plus demo
purchase codes `DEMO-0001`, `DEMO-0002`, `DEMO-0003` and `DEMO-EXPIRED`. Type a
code on the app's "enter code" screen.

**OTP codes in development:** no SMS is sent. The code is printed in the
server terminal as `[dev-sms] OTP for +994…: 123456`.

## Point the app at it

In `Epsilon-Front-End/.env.local`:

```
EXPO_PUBLIC_API_MODE=live
EXPO_PUBLIC_API_URL=http://10.0.2.2:3000/v1
```

- Android emulator: `10.0.2.2` is your PC's `localhost`.
- Real phone on the same Wi-Fi: use your PC's LAN IP instead, for example
  `http://192.168.1.20:3000/v1`, and allow port 3000 in Windows Firewall.
- Restart Metro with `npx expo start -c` after changing env values.

Two limits on the app side:

- The app's `app.config.ts` sets `usesCleartextTraffic: false`, so Android
  builds block plain `http://`. For local testing, either allow cleartext in
  development builds only and rebuild, or expose the API over HTTPS with a
  tunnel such as `cloudflared tunnel --url http://localhost:3000`, then use
  that `https://…/v1` URL.
- The app's live adapter rejects `login` and `register` intents before sending
  them. The server already supports intents: it returns `ACCOUNT_NOT_FOUND`
  (404) or `ACCOUNT_EXISTS` (409). Turn this on in the app with
  `requireAuthIntentSupport(intent, true)` when you are ready.

## Scripts

| Command               | What it does                                             |
| --------------------- | -------------------------------------------------------- |
| `npm run dev`         | Start with auto-reload                                   |
| `npm start`           | Start without reload                                     |
| `npm test`            | Run the auth and money tests (no database needed)        |
| `npm run test:contract` | Check responses against the app's Zod schemas (needs `../Epsilon-Front-End`) |
| `npm run typecheck`   | Run the TypeScript check                                 |
| `npm run db:generate` | Create a new migration after you edit `src/db/schema.ts` |
| `npm run db:migrate`  | Apply migrations to `DATABASE_URL`                       |
| `npm run db:seed`     | Add demo data. Skipped if restaurants already exist; refused in production |

## API (`/v1`)

| Endpoint                                                     | Auth   |
| ------------------------------------------------------------ | ------ |
| `GET /config`                                                | public |
| `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/google`, `/auth/refresh` | public |
| `POST /auth/logout`                                          | bearer |
| `GET / PATCH / DELETE /me`                                   | bearer |
| `POST /me/phone/otp/request`, `/me/phone/otp/verify`         | bearer |
| `GET / PUT /me/notification-settings`, `POST /devices`       | bearer |
| `GET /restaurants`, `/restaurants/:id`                       | bearer |
| `POST /receipts/resolve`, `GET /receipts/:id`                | bearer |
| `POST / GET /feedback`                                       | bearer |
| `GET /wallet`, `/wallet/transactions`, `/wallet/transactions/:id` | bearer |

Response shapes match `src/services/contracts/index.ts` in the app. Errors use
`{"error":{"code","message","requestId"}}` and an `X-Request-Id` header.

Authenticated mutations require an `Idempotency-Key` header, which the app
always sends:

- The same key with the same body replays the stored response.
- The same key with a different body returns 422 and changes nothing.

## How the important rules are enforced

- **Logins:** OTP codes are stored only as HMAC hashes. A code expires after 2
  minutes and allows 5 attempts. Each phone gets one code per 60 s and at most
  5 per hour. Each IP gets 10 auth calls per minute.
- **Sessions:** Access tokens are 15-minute JWTs. Refresh tokens are random
  values stored as SHA-256 hashes and rotate on every refresh. Reusing an old
  refresh token revokes the whole session family. Logout and deletion revoke
  the session server-side.
- **Account linking:** There is no linking by email. A phone is linked only by
  OTP from inside a signed-in account. Database unique constraints make each
  phone and each Google account belong to exactly one user.
- **Account deletion:** You must have signed in within the last 10 minutes.
  Deletion erases the name, phone, email and birth date, revokes all sessions,
  and frees the phone. Feedback and ledger rows stay, attached to the anonymised
  user.
- **Money:** All amounts are integer qəpik. The wallet is an append-only
  `ledger_entries` table, and the balance is always `SUM` of the confirmed rows.
  A partial unique index allows only one reward per feedback, and a unique
  index allows only one feedback per purchased item. Duplicate or concurrent
  submissions cannot pay twice.
- **Receipts:** Only the SHA-256 of a purchase code is stored. A receipt can be
  claimed by one user only, and only its owner can read it or rate its items.

## Placeholders that need an owner decision

- **Reward rule:** each restaurant's `cashback_bps` of the rated line price,
  confirmed immediately (`src/lib/money.ts`). There is no reward when
  `REQUIRE_PHONE_VERIFICATION=true` and the user has no verified phone.
- **SMS provider:** only the dev console sender exists. Add a real sender in
  `src/auth/sms.ts`, for example Twilio, before production. Production refuses
  to start with `SMS_PROVIDER=console`.
- **Idempotency purge:** idempotency rows are never purged. Add a job that
  deletes rows older than 8 days.
- **Store review account:** none is configured. Deletion retention and the
  menu/catalog API are also not built (menus are stored, but the app has no
  live menu endpoint yet).

## Hosting later

Run the API on Render or Fly.io and the database on Neon (managed Postgres).
Set the same env variables there with `NODE_ENV=production`. Run
`npm run db:migrate` on deploy. Point the app at the HTTPS URL, which
production builds require.
