# Rhinocash — Microfinance Management System

A complete microfinance management system: real Node.js backend (zero
`npm install` — Node 20+ built-ins only), real SQLite database, and a
real single-file frontend that talks to the backend over `fetch()` for
every piece of data and every action. Not a prototype, not a demo with
mock/local state.

```
rhinocash-backend/   the real backend — see rhinocash-backend/README.md
rhinocash-app/       the real frontend (index.html)
```

## Quick start

```bash
cd rhinocash-backend
node seed.js --demo   # sets up roles/permissions/workflow + sample data
node server.js         # -> http://localhost:4000
```

Then open `rhinocash-app/index.html` directly in a browser — it talks to
`http://localhost:4000` by default.

## Running the tests

```bash
cd rhinocash-backend
bash test/run-all.sh        # backend: 776 assertions across 24 suites
bash test/run-frontend.sh   # frontend: 464 assertions, driving the real
                             # UI functions in ../rhinocash-app/index.html
                             # end-to-end against a live backend
```

Current baseline: **776 backend + 464 frontend = 1,240 tests, 0 failures.**
Both scripts handle fresh-seeding and server startup/shutdown themselves.

## What's real vs. explicitly not verified

See `rhinocash-backend/docs/STATUS_REPORT.md` for the complete, honest
breakdown — including what has genuinely been tested end-to-end (the
full loan lifecycle, RBAC across 9 roles, branch/region scoping,
accounting integrity, M-Pesa/Support/Reports/System Administration, and
more) versus what's explicitly **not** live-verified (Safaricom M-Pesa,
SMS/Email providers, PostgreSQL migration, production deployment,
restore-from-backup, and mobile/responsive UX).

## Security

See `rhinocash-backend/docs/SECURITY_CHECKLIST.md` for the itemized
pre-production checklist, and `rhinocash-backend/docs/RBAC.md` for how
the permission and branch/region scoping model actually works.

## Configuration

Copy `rhinocash-backend/.env.example` to `rhinocash-backend/.env` for
production configuration — nothing there is required for local
development (see the file's own comments for what each variable does).
No secrets, credentials, or local databases are committed to this
repository — see `.gitignore` and `rhinocash-backend/.gitignore`.
