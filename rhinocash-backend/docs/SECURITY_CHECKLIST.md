# Security Checklist

Honest status per item — "Done" means implemented AND covered by a
passing automated test; "Partial" means implemented but with a known gap;
"Deployment" means it's the deploying team's responsibility, not
something a codebase can solve on its own.

| Item | Status | Notes |
|---|---|---|
| Password hashing | Done | `node:crypto` scrypt, per-user random salt, `timingSafeEqual` comparison. No plaintext password ever stored or logged. |
| Secure session tokens | Done | HMAC-SHA256 signed, JWT-shaped. Signature verified on every request. |
| Real session revocation | Done | Sessions also checked against a server-side `sessions` table by hash — unlike a plain JWT, a revoked token stops working immediately, not just at natural expiry. Tested (`v2.test.js`: "the exact same token is now rejected"). |
| Session expiration | Done | 12-hour TTL, enforced server-side on every request. |
| Forced password change | Done | New accounts (Admin-created or seed-created) are flagged `must_change_password`; enforced before other password-change validation applies. |
| Failed login tracking | Done | Every attempt (success and failure) logged to `login_attempts` with reason. |
| Account lockout / login throttling | Done | 5 failed attempts in 15 minutes → 429, per email. |
| General rate limiting | Done | 180 req/min/IP across the whole API (configurable via `RATE_LIMIT_PER_MINUTE`), separate from the login-specific lockout. Actually triggers 429 under test, not just present. |
| Authorization on every protected route | Done | `requireAuth` + `requireModule`/`requirePermission` on every route in every route file — verified by grepping route registrations, not just spot-checked. |
| Object-level authorization (not just lists) | Done | `assertRecordInScope` on every `GET/PATCH/:id` and action route across clients/loans/payments. Tested directly (`v2.test.js` section 1). |
| Cross-branch write prevention | Done | `resolveWriteBranchId` — client-supplied `branch_id` is never trusted for restricted roles. Tested. |
| Input validation | Partial | Every route validates required fields and referenced-record existence (e.g. loan principal vs. product min/max, unknown role_id, unknown loan/client id). What's **not** implemented: schema-level type/format validation (e.g. phone number format, email format beyond a lowercase check) — worth adding a small validation layer before production. |
| Payload size limits | Done | JSON bodies capped at 2MB (`router.js`); file uploads capped at 5MB with content-type allowlist (`server.js`). |
| SQL injection protection | Done | Every query uses parameterized `?` placeholders, translated to PostgreSQL's `$n` positional parameters and sent through `pg`'s parameterized query API — no string-concatenated SQL anywhere in the codebase. |
| Secure file uploads | Done | Content-type allowlist (png/jpeg/webp/pdf), size cap, random filename (not the client-supplied name) written to disk, path traversal check on read (`p.startsWith(UPLOAD_DIR)`). |
| Audit logging | Done | Every sensitive action (login, user/access changes, loan approvals, payments, reversals, branch decisions, permission changes) logs actor, action, entity, previous/new value, reason, IP, user-agent, timestamp. Read access itself is `audit`-module-gated. |
| Safe error responses | Done | 5xx responses never leak the underlying error message/stack to the client — only logged server-side. 4xx messages are intentionally descriptive (they come from our own validation code, not a driver). |
| Security headers | Done | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Resource-Policy`; `Strict-Transport-Security` when `NODE_ENV=production`. |
| CORS configuration | Done | Configurable via `CORS_ORIGIN`; defaults to `*` for local development — **must** be set to the real frontend origin before production. |
| Secrets management | Done | `SESSION_SECRET` read from env if set, otherwise generated once and persisted outside source control (`data/.session_secret`, already `.gitignore`d). No secret is ever hardcoded in a source file. Initial Admin password is generated at seed time, printed once, never stored in plaintext. |
| HTTPS | Deployment | This app speaks plain HTTP; TLS termination is expected to happen at your platform/load-balancer/reverse-proxy (Render, Railway, nginx, etc.) — not something the app itself should implement. |
| Database backup strategy | Deployment | Use your PostgreSQL provider's automated backups (Supabase/Neon/RDS all offer this) — do not build a custom backup mechanism into the app. The in-app "Backup" feature (System Administration) captures a real application-level snapshot of live data for operational/audit purposes; it is not a substitute for your provider's point-in-time recovery. |
| Dependency vulnerabilities | Minimal | One production dependency (`pg`, the PostgreSQL driver) — run `npm audit` against it periodically as you would for any dependency. |
| Multi-instance rate-limit consistency | Known gap | `src/rateLimit.js` is in-memory per process. Fine for a single instance; needs a shared store (Redis or a Postgres table) once you scale to multiple instances. |
| Real email/SMS delivery for password resets, statements, alerts | Known gap | Interfaces exist (`src/integrations/{sms,email}.js`) and report `NOT_CONFIGURED` honestly; no real provider is wired up (no credentials available to build against). |
| M-Pesa live integration | Done (config layer) / Deployment (live success) | Real Admin-only config UI, AES-256-GCM encryption at rest (verified by reading raw DB bytes in tests), masked display, audit-without-secrets, and a genuine OAuth "Test Connection" call. Cannot verify a successful handshake against Safaricom's real servers from this build environment (network egress doesn't reach them) — the code path is real, a live result depends on real deployment network access + real credentials. |
| Secrets encrypted at rest (M-Pesa credentials) | Done | AES-256-GCM, `src/crypto.js`. `MPESA_ENCRYPTION_KEY` env var in production, auto-generated+persisted otherwise (same pattern as `SESSION_SECRET`). Verified in `test/mpesaConfig.test.js` by reading the stored database row directly (bypassing the app's own decrypt path) and confirming plaintext secrets appear nowhere in it. |

## Before going to production, at minimum

1. Set `DATABASE_URL` to a real, provider-backed PostgreSQL instance (not
   a local dev database), plus `SESSION_SECRET`, `CORS_ORIGIN`, and
   `NODE_ENV=production` explicitly.
2. Run `node seed.js` (without `--demo`) fresh, capture the printed Admin
   credential securely, and force the change immediately — don't reuse the
   one from any earlier test run.
3. Put a real TLS-terminating reverse proxy in front of this process.
4. If you expect to run more than one instance behind a load balancer,
   address the multi-instance rate-limiter gap above first.
5. Wire at least email or SMS for password resets before relying on the
   "reset-password returns the temp password to the Admin" flow as your
   only distribution mechanism in a multi-admin organization.
