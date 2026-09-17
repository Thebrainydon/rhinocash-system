# PostgreSQL architecture

Rhinocash V2 runs on PostgreSQL exclusively — `src/db.js` is the only
file that knows this, and every route file talks to the database only
through its exported `all()` / `get()` / `run()` / `transaction()`
helpers. This document covers the schema and driver-level decisions
worth knowing if you're extending the schema or debugging a query.

## Connection and query helpers

`src/db.js` wraps a `pg` `Pool` (`DATABASE_URL`, pool size via
`PGPOOL_MAX`, default 10). All four exported helpers are async:

```js
const { all, get, run, transaction } = require('./db');
const rows = await all('SELECT * FROM loans WHERE branch_id = ?', [branchId]);
const row  = await get('SELECT * FROM loans WHERE id = ?', [loanId]);
const { changes } = await run('UPDATE loans SET status = ? WHERE id = ?', [status, loanId]);
await transaction(async () => {
  await run('UPDATE loans SET status = ? WHERE id = ?', ['Active', loanId]);
  await run('INSERT INTO journal_entries (...) VALUES (...)', [...]);
});
```

Every call site across the codebase uses `?` placeholders, exactly as the
original SQLite version did — `db.js` rewrites them to PostgreSQL's
`$1, $2, ...` positionally at the query-execution boundary
(`toPgParams()`), so no route file needed manual placeholder renumbering
during the migration and none is needed if you add a query today.

## Transaction propagation

`transaction(fn)` uses `node:async_hooks`'s `AsyncLocalStorage` to make
every `all/get/run` call made *anywhere* inside `fn` — including calls
several function layers deep, with no `client` parameter threaded through
any of those signatures — automatically join the same pooled connection
and the same `BEGIN`/`COMMIT`/`ROLLBACK`. A `transaction()` call made
while already inside another one joins the outer transaction rather than
opening a second one (checked directly in `test/atomicity.test.js`,
including deliberate mid-transaction failure injection to prove a
partial write never survives a thrown error).

This is what backs every multi-step financial write in the system: a
loan disbursement's status flip + schedule build + two journal-entry
inserts either all commit or all roll back, never some subset.

## Schema design decisions (deliberately conservative)

A few choices were made specifically to minimize behavioral drift from
the pre-migration version, each documented inline in `src/db.js`'s
`SCHEMA` constant:

- **IDs stay app-generated `TEXT`**, not native `UUID` — every route
  already generates its own prefixed ids (`ln_...`, `cl_...`, `pm_...`)
  via `crypto.randomUUID()`, so there was no reason to introduce a second
  id scheme.
- **Timestamp columns stay `TEXT`**, storing exact ISO-8601 strings
  (`2026-01-15T10:30:00.000Z`), not native `TIMESTAMPTZ`. Two small SQL
  functions produce them: `iso_now()` and `iso_offset(interval)` (e.g.
  `iso_offset(interval '-15 minutes')`). This keeps every existing
  `new Date(row.created_at)` call in the JS layer working unchanged, and
  keeps the exact string format the frontend already expects.
- **Boolean flags stay `INTEGER` 0/1**, not native `BOOLEAN` — matches
  every existing `= 1` / `= 0` comparison in the route files.
- **Money columns are `NUMERIC(14,2)`**; percentage/rate columns are
  `NUMERIC(9,4)`. This is a genuine, real improvement over the previous
  engine: exact storage and exact `SUM()`/aggregate arithmetic at the SQL
  level, with no floating-point accumulation error. See "Financial
  precision" below for what this does and doesn't cover.
- **Seven tables use `BIGSERIAL PRIMARY KEY`** where the old schema used
  SQLite's `INTEGER PRIMARY KEY AUTOINCREMENT`: `login_attempts`,
  `audit_logs`, `loan_approvals`, `loan_schedule`, `journal_entries`,
  `notifications`, `payment_allocations`. Everywhere else, ids are the
  app-generated `TEXT` ids described above. If a route ever accepts one
  of these numeric ids from a URL param, validate it's actually numeric
  before querying — PostgreSQL throws a cast error on a non-numeric
  string compared against a `bigint` column (SQLite silently returns no
  match instead), which is a real difference from the old engine's
  behavior worth knowing about.

## Circular foreign key

`branches.manager_id → users.id` and `users.branch_id → branches.id` are
circular. PostgreSQL (unlike SQLite) validates foreign key targets at
`CREATE TABLE` time, so both columns are created as plain `TEXT` and the
actual `FOREIGN KEY` constraints are added afterward via `ALTER TABLE ...
ADD CONSTRAINT`, guarded by an existence check against `pg_constraint` so
re-running schema init on an already-initialized database is a no-op, not
an error.

## Type parsers

`pg`'s default type mapping returns `NUMERIC` and `BIGINT` columns as
JavaScript strings (to avoid silent precision loss on values outside
`Number`'s safe range). Two custom parsers in `db.js`
(`types.setTypeParser`) convert them back to JS numbers on the way out —
`NUMERIC` via `parseFloat`, `BIGINT` via `parseInt` — so every existing
route file's arithmetic and JSON response shapes work exactly as they did
against SQLite, without a second type-conversion layer scattered across
route files.

## SQL translated during the migration

If you're writing a new query, these are the patterns that differ from
SQLite and were fixed everywhere they appeared:

| SQLite | PostgreSQL |
|---|---|
| `datetime('now')` | `iso_now()` |
| `datetime('now', '-15 minutes')` | `iso_offset(interval '-15 minutes')` |
| `date(x)` | `(x)::date` |
| `date('now')` | `CURRENT_DATE` (cast to `::text` if comparing against a `TEXT` column) |
| `date('now','start of month')` | `date_trunc('month', CURRENT_DATE)::date` |
| `strftime('%Y-%m', x)` | `to_char(x::timestamptz, 'YYYY-MM')` |
| `INSERT OR IGNORE INTO ...` | `INSERT INTO ... ON CONFLICT DO NOTHING` |
| `MAX(a, b)` / `MIN(a, b)` (scalar, two args) | `GREATEST(a, b)` / `LEAST(a, b)` — SQLite's `MAX`/`MIN` are overloaded as scalar functions when given 2+ args; PostgreSQL's `MAX`/`MIN` are aggregate-only |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` |

One easy-to-miss trap: comparing a `TEXT`-typed timestamp/date column
(which is every one of them here — see above) directly against
`CURRENT_DATE` or a `::date`-cast parameter throws `operator does not
exist: text < date` — PostgreSQL does not implicitly cross-cast the way
SQLite does. Cast the column itself, e.g. `(due_date)::date < CURRENT_DATE`
or `(due_date)::date BETWEEN (?)::date AND (?)::date`, not just the other
side of the comparison.

## Financial precision — what changed and what didn't

**What genuinely improved:** money columns are exact `NUMERIC(14,2)` now,
so every SQL-level `SUM()`/aggregate over money columns is exact — no
floating-point accumulation error from adding many rows together, which
is a real class of bug the previous engine's `REAL` columns didn't fully
rule out.

**What was deliberately left unchanged:** the JavaScript calculation
layer (interest computation, schedule building, allocation splitting)
still does plain IEEE-754 double arithmetic, exactly as it did against
the previous engine — no decimal-arithmetic library was introduced
end-to-end. This is a conscious scope decision, not an oversight: the
existing codebase already uses epsilon-tolerant comparisons (`- 0.01`)
defensively throughout, realistic loan amounts are far within a double's
safe-integer range, and a full decimal rewrite of every calculation
function would be a substantially larger, separate, higher-risk project
than migrating the storage engine. If your deployment needs
arbitrary-precision arithmetic guarantees beyond what's described here,
treat that as a distinct follow-up project, not something this migration
already covers.

## Test database

`TEST_DATABASE_URL` (see `test/run-all.sh`) points at a **separate**
PostgreSQL database, reset to a genuinely empty schema
(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`) before every single
test suite. The app's own real startup self-test then rebuilds the full
schema fresh on next connect — the exact same code path production uses
to initialize a brand-new database, never a second, hand-maintained
schema definition for tests. See `README.md` → "Running the tests" for
setup.
