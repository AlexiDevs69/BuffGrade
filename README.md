# BuffGrade

CS2 case simulator. Virtual currency only: nothing can be bought, withdrawn or traded for real value.
All game logic (prices, odds, drops, balance) runs on the server; the browser only displays results.

## Run

    npm install
    npm start        # http://localhost:3000
    npm test         # 14 integration tests, no network needed

Needs Node 20+. On first start the server downloads the CS2 catalog from ByMykel/CSGO-API
and caches it in `data/crates.json` (used as a fallback if GitHub is unreachable later).

## Deploy checklist

1. Serve over HTTPS and set `NODE_ENV=production` (cookie becomes Secure and `__Host-` prefixed).
2. Set `TRUST_PROXY=1` behind one reverse proxy, otherwise rate limits see the proxy's IP.
3. Put `DB_PATH` on a persistent disk. SQLite on an ephemeral filesystem (many free tiers) loses every account on redeploy.
4. Run a single instance (SQLite and in-memory rate limits are single-process).
5. Back up the DB on a schedule: `sqlite3 buffgrade.db ".backup backup.db"`.

## Security model

| Threat | Mitigation |
|---|---|
| Client forges price, drop or balance | Client sends only ids; server reads prices from its own catalog |
| Double spend, double sell, races | One `BEGIN IMMEDIATE` transaction per action, guarded `UPDATE ... WHERE balance >= ?`, `CHECK(balance >= 0)` |
| Selling or upgrading another user's item | Every item query is scoped by `user_id`; all-or-nothing |
| Predictable drops | `crypto.randomInt` (CSPRNG); the result is decided before the animation |
| Upgrade exploits | Chance computed server-side from stored prices; below 1% is refused, never clamped up; 5% fee; max 10 items |
| Password theft from DB | scrypt (N=2^16, r=8), per-user salt, parameters stored in the hash, timing-safe compare |
| Session theft / fixation | 256-bit token, only its SHA-256 stored, HttpOnly + SameSite=Lax (+ Secure in prod), new token on login, all sessions revoked on password change |
| Brute force | Per IP+nick (8 failures / 15 min), per IP, per-user game limits; dummy hash so unknown nicks cost the same time |
| User enumeration on login | One generic error message, equal timing |
| CSRF | SameSite=Lax + JSON-only + Origin / Sec-Fetch-Site check |
| XSS | Strict CSP (`script-src 'self'`, no inline scripts); the client never uses `innerHTML` |
| Hostile catalog data | Image URLs must be https on an allow-listed host, everything else is dropped |
| SQL injection | Prepared statements only; ids validated by regex and length |
| Info leaks | Generic 500 body, stack traces only in server logs, `x-powered-by` off, `/api` is `no-store` |

## Economy knobs (`server/catalog.js`)

`BASE` (tier prices), `ODDS_BP` (drop odds), `CASE_MARGIN` (case price = 1.3 x expected value, about 75% return), `ST_MULT`.
The median drop is much cheaper than the mean because most value sits in rare drops, so tune with real playtests.

## Known limitations / next steps

- No email, so no password recovery. Add OAuth (Google/Discord) or email verification + reset tokens.
- Registration is rate-limited per IP, but multi-accounting for the daily bonus is possible. This matters as soon as trading or battles exist.
- Rate limits are in memory and reset on restart; use Redis if you scale out.
- The catalog refreshes only on restart.
- No admin tools; the `ledger` table exists for auditing.
- Case battles need WebSockets and a server-side match state machine; build them on the same transaction pattern.
