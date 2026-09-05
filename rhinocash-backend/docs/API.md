# API Reference

> **Scope note:** this document covers the core modules from earlier in
> the project (auth, users, branches, clients, loans, payments,
> accounting, investors, audit, dashboard, M-Pesa admin, uploads). Several
> modules built later — Reports & Analysis (`src/routes/reports.js`),
> Support Center (in `src/routes/misc.js`), System Administration
> (`src/routes/systemAdmin.js`), System Health (`src/routes/systemHealth.js`),
> Targets (`src/routes/targets.js`), and Collections
> (`src/routes/collections.js`) — are not yet documented here. For those,
> the corresponding `test/*.test.js` file is the authoritative reference:
> every request/response shape shown there actually ran against the real
> route. See `docs/STATUS_REPORT.md` for the full module list.

All endpoints are JSON over HTTP. Authenticated requests send
`Authorization: Bearer <token>` (obtained from `/api/auth/login` or
`/api/investor-auth/login`). Every response is `application/json`.

**Format note:** with 60+ endpoints, giving each its own full worked
request/response example would make this document unusable as a
reference. Instead: every row below states its auth requirement,
required module, required permission, and branch/region scope precisely
(these are the parts that differ per endpoint and matter for
integration); full worked examples for the four representative flows
(login, create+approve a loan, record a payment, branch opening) are in
`test/integration.test.js`, `test/v2.test.js`, and
`test/branchExpansion.test.js` — those are real, currently-passing HTTP
calls against this exact API, which is a stronger source of truth than
hand-written examples that can drift out of sync with the code.

Legend: **Auth** = `requireAuth` (any logged-in user/investor as noted).
**Module** = `requireModule('x')`. **Perm** = `requirePermission('x')`.
**Scope** = branch/region enforcement applied, if any.

## Auth (`src/routes/auth.js`)

| Method | Path | Auth | Module | Perm | Scope | Notes |
|---|---|---|---|---|---|---|
| POST | /api/auth/login | none | – | – | – | `{email,password}` → `{token,user,mustChangePassword}`. Tracks failed attempts (429 after 5 in 15 min); blocks non-Active accounts. |
| POST | /api/auth/logout | Yes | – | – | – | Revokes the current session token. |
| GET | /api/auth/me | Yes | – | – | – | Returns the caller's own user + computed final access. |
| POST | /api/auth/change-password | Yes | – | – | – | `{currentPassword,newPassword}` (currentPassword skipped if must_change_password). Revokes all other sessions. |
| POST | /api/users/:id/reset-password | Yes | – | manage_users + **Admin only** | – | Generates a real temp password, returns it once to the caller. |
| POST | /api/users/:id/revoke-sessions | Yes | – | manage_users + **Admin only** | – | Revokes every active session for that user. |

## Users & Staff (`src/routes/users.js`)

| Method | Path | Auth | Module | Perm | Scope | Notes |
|---|---|---|---|---|---|---|
| GET | /api/users | Yes | staff | – | – | Full directory. |
| GET | /api/users/:id | Yes | staff | – | – | |
| POST | /api/users | Yes | – | manage_users | role-tier | CEO/Director blocked from creating Admin/CEO/Director. |
| PATCH | /api/users/:id | Yes | – | manage_users | role-tier | Same role-tier check on both current and requested role. |
| POST | /api/users/:id/status | Yes | – | manage_users | role-tier + role-specific | Director: none; CEO: Active/Suspended only; Admin: all three. |
| PUT | /api/users/:id/module-access | Yes | – | manage_users + **Admin only** | – | `{modules:[...]}` |
| PUT | /api/users/:id/permissions/:permissionId | Yes | – | manage_users + **Admin only** | – | `{allowed:true|false, reason}` |
| DELETE | /api/users/:id/permissions/:permissionId | Yes | – | manage_users + **Admin only** | – | |
| POST | /api/users/:id/reset-access | Yes | – | manage_users + **Admin only** | – | Clears module/permission overrides, resets access_level to role default. |
| GET | /api/users/:id/final-access | Yes | staff | – | – | |
| GET | /api/users/:id/activity | Yes | audit | – | – | |
| GET | /api/users/:id/login-history | Yes | audit | – | – | |
| GET | /api/roles | Yes | – | – | – | |
| GET | /api/modules | Yes | – | – | – | |
| GET | /api/permissions | Yes | – | – | – | |
| GET | /api/roles/:id/permissions | Yes | – | – | – | |
| PUT | /api/roles/:id/permissions/:permissionId | Yes | – | manage_users + **Admin only** | – | Edits the role-level default matrix. |

## Branches & Regions (`src/routes/branches.js`)

| Method | Path | Auth | Module | Perm | Scope | Notes |
|---|---|---|---|---|---|---|
| GET | /api/branches | Yes | – | – | – | |
| GET | /api/regions | Yes | – | – | – | |
| POST | /api/branches | Yes | – | **Admin only** | – | Direct-create override; bypasses the proposal workflow. |
| PATCH | /api/branches/:id | Yes | – | manage_branches | – | |
| GET | /api/branch-proposals | Yes | staff | – | – | |
| GET | /api/branch-proposals/:id | Yes | staff | – | – | |
| POST | /api/branch-proposals | Yes | – | open_new_branch | – | The real "Open New Branch" entry point. |
| POST | /api/branch-proposals/:id/approve | Yes | – | **Admin or CEO only**, not the proposer | – | Creates the real `branches` row. |
| POST | /api/branch-proposals/:id/reject | Yes | – | **Admin or CEO only** | – | |
| POST | /api/branches/:id/close | Yes | – | manage_branches | – | Blocked while active loans exist. |
| GET | /api/branches/:id/performance | Yes | reports | – | – | Real numbers, computed on demand. |

## Clients (`src/routes/clients.js`)

| Method | Path | Auth | Module | Perm | Scope | Notes |
|---|---|---|---|---|---|---|
| GET | /api/clients | Yes | clients | – | list-filtered | |
| GET | /api/clients/:id | Yes | clients | – | **object-level** | 403 if outside caller's branch scope. |
| POST | /api/clients | Yes | clients | – | write-resolved | `branch_id` in body is ignored/validated per `resolveWriteBranchId`. |
| PATCH | /api/clients/:id | Yes | clients | – | **object-level** + write-resolved on branch move | |
| POST | /api/clients/:id/interactions | Yes | clients | – | object-level via client | |
| POST | /api/clients/:id/documents | Yes | clients | – | object-level via client | Metadata only — see Uploads. |
| GET | /api/leads | Yes | clients | – | – | |
| POST | /api/leads | Yes | clients | – | – | |
| POST | /api/leads/:id/convert | Yes | clients | – | write-resolved | |

## LoanBook (`src/routes/loans.js`)

| Method | Path | Auth | Module | Perm | Scope | Notes |
|---|---|---|---|---|---|---|
| GET | /api/loan-products | Yes | – | – | – | |
| POST | /api/loan-products | Yes | – | manage_system_settings | – | |
| GET | /api/loans | Yes | loanbook | – | list-filtered (+ own portfolio for Loan Officer) | |
| GET | /api/loans/arrears | Yes | loanbook | – | list-filtered | Registered before `/:id` — see router note in code. |
| GET | /api/loans/:id | Yes | loanbook | – | **object-level** | |
| POST | /api/loans | Yes | loanbook | – | via client scope + write-resolved | Rejects principal outside product min/max. |
| POST | /api/loans/:id/approve | Yes | – | approve_loans | **object-level + workflow step + not self-submitted** | |
| POST | /api/loans/:id/reject | Yes | – | approve_loans | same as approve | |
| POST | /api/loans/:id/return | Yes | – | approve_loans | same as approve | Resets to step 1. |
| POST | /api/loans/:id/disburse | Yes | – | disburse_loans | object-level | Only from `Approved for Disbursement`; posts a balanced 2-leg journal entry. |
| POST | /api/loans/:id/write-off | Yes | – | write_off_loans | object-level | |
| POST | /api/loans/:id/restructure | Yes | – | approve_loans | object-level | `{new_term_months, reason}` |

## Payments (`src/routes/payments.js`)

| Method | Path | Auth | Module | Perm | Scope | Notes |
|---|---|---|---|---|---|---|
| GET | /api/payments | Yes | payments | – | filtered by underlying loan's branch | |
| POST | /api/payments | Yes | – | record_payments | object-level via loan | Duplicate-payment guard (same loan/amount/channel within 2 min → 409 unless `confirm_duplicate:true`). Posts a balanced 2–4-leg journal entry (funding account, principal, interest, overpayment suspense). |
| POST | /api/payments/:id/post | Yes | – | record_payments | object-level via loan | Posts the ledger entries that were deferred when the payment was left unposted — this was a real bug fixed in V2 (previously silent). |
| POST | /api/payments/:id/reverse | Yes | – | reverse_payment | object-level via loan | Rejects a second reversal of the same payment (409). |

## Accounting (`src/routes/accounting.js`)

| Method | Path | Auth | Module | Perm | Scope | Notes |
|---|---|---|---|---|---|---|
| GET | /api/expenses | Yes | accounting | – | – | |
| POST | /api/expenses | Yes | – | post_accounting_entries | – | Posts a balanced 2-leg entry (expense account debited, funding account credited). |
| GET | /api/accounts | Yes | accounting | – | – | Chart of Accounts. |
| GET | /api/journal-entries | Yes | accounting | – | – | Raw ledger, most recent 300. |
| GET | /api/accounting/cash-position | Yes | accounting | – | – | Real balances via `ledgerBalance()`. |
| GET | /api/accounting/trial-balance | Yes | accounting | – | – | Includes `balanced: true/false` — the debits=credits invariant, checked live. |
| GET | /api/accounting/profit-and-loss | Yes | accounting | – | – | |
| GET | /api/accounting/balance-sheet | Yes | accounting | – | – | |

## Investors (`src/routes/investors.js`) — separate auth, see RBAC.md

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /api/investor-auth/login | none | Returns an investor-typed token, structurally different from staff tokens. |
| GET | /api/investor/me | Investor token | Own record only. |
| GET | /api/investor/payouts | Investor token | Own payouts only. |
| GET | /api/investor/company-performance | Investor token | Aggregate-only figures, no client/staff detail. |
| POST | /api/investors/:id/payouts/:period/mark-paid | Staff, manage_users | Admin/CEO/Director-side action. |

## Staff HR / Support / Notifications (`src/routes/misc.js`)

| Method | Path | Auth | Module | Perm/Scope | Notes |
|---|---|---|---|---|---|
| GET | /api/notifications | Yes | – | own-only (`user_id = caller` OR broadcast) | |
| POST | /api/notifications/:id/read | Yes | – | **ownership-checked** | 403 if it's not yours; 404 if it doesn't exist. Fixed a real hijack bug in V2. |
| GET | /api/support-tickets | Yes | support | **role/branch-scoped visibility** | Owner sees own; Manager-tier sees their branch/region; Admin sees all; CEO/Director see Critical-priority + their own. |
| GET | /api/support-tickets/:id | Yes | support | same visibility rule | |
| POST | /api/support-tickets | Yes | support | – | Captures `branch_id` from the creator. |
| PATCH | /api/support-tickets/:id | Yes | support | visible-to-you + (owner or managerial) | |
| GET | /api/leave-requests | Yes | – | `?mine=1` for own; else your direct reports (or all, if manage_users) | |
| POST | /api/leave-requests | Yes | – | – | |
| POST | /api/leave-requests/:id/decide | Yes | – | **must be the requester's reporting_manager_id, or manage_users** | Never the requester themselves. |
| GET | /api/salary-advances | Yes | – | same as leave-requests | |
| POST | /api/salary-advances | Yes | – | – | |
| POST | /api/salary-advances/:id/decide | Yes | – | same as leave decide | |

## Audit (`src/routes/audit.js`)

| Method | Path | Auth | Module | Notes |
|---|---|---|---|---|
| GET | /api/audit-logs | Yes | audit | `?entity=X`, `?user_id=Y` filters. Not reachable without the `audit` module (Admin/Director only by default). |

## Dashboard (`src/routes/dashboard.js`)

| Method | Path | Auth | Scope | Notes |
|---|---|---|---|---|
| GET | /api/dashboard/summary | Yes | branch/region/own-portfolio per role | Outstanding portfolio, arrears, PAR, disbursed MTD, collections MTD — all computed live. |

## M-Pesa Admin Configuration (`src/routes/mpesaAdmin.js`) — Admin only

| Method | Path | Auth | Perm | Notes |
|---|---|---|---|---|
| GET | /api/admin/mpesa/config | Yes | manage_system_settings + **role_id==='admin'** | Masked view of both environments + active flag + last-test status. |
| GET | /api/admin/mpesa/setup-guide | Yes | same | Real, static step-by-step Daraja setup instructions. |
| PUT | /api/admin/mpesa/config/:environment | Yes | same | Partial update — omitted fields keep their existing encrypted value. Encrypts consumerKey/consumerSecret/passkey before storing. Audit logs field names only, never values. |
| DELETE | /api/admin/mpesa/config/:environment | Yes | same | Clears that environment's config; also clears the active flag if it was the active one. |
| POST | /api/admin/mpesa/set-active | Yes | same | `{environment}`. 409 if that environment isn't fully configured yet. |
| POST | /api/admin/mpesa/test-connection/:environment | Yes | same | Makes a real OAuth request to Safaricom for that environment; records `Connection Successful`/`Connection Failed` + a safe message. |

Public (no auth — this is Safaricom calling us, not a user):

| Method | Path | Notes |
|---|---|---|
| POST | /api/mpesa/callback/:environment | Real STK-push result callback handler. Idempotent by `CheckoutRequestID`. Always acknowledges with `{ResultCode:0,ResultDesc:'Accepted'}` regardless of internal outcome, per Daraja's expected contract. |

## Uploads & Avatar (`server.js`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /api/uploads | Yes | Raw binary body + `Content-Type` (png/jpeg/webp/pdf only) + `X-Filename` header. 5MB cap. Returns `{path}`. |
| GET | /uploads/:name | none | Serves the stored file. |
| POST | /api/users/me/avatar | Yes | `{path}` from a prior upload. |
| DELETE | /api/users/me/avatar | Yes | |

## Integrations status

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | /api/integrations/status | none | `{mpesa,sms,email}` each `CONFIGURED`/`NOT_CONFIGURED`, plus `mpesaDetail:{sandbox,production,active}` with the exact per-environment status strings (`Not Configured`/`Sandbox Configured`/`Production Configured`/`... (inactive)`). Never fakes readiness. |

## System

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | /api/health | none | `{ok:true,time}` |

## Error format

Every error response is `{ "error": "message" }`, optionally with a
`code` field for machine-matchable cases (currently only
`POSSIBLE_DUPLICATE` on payments). 5xx responses always say `Internal
server error` regardless of the underlying cause — the real error is
logged server-side only, never leaked to the client (see `src/router.js`).

| Status | Meaning |
|---|---|
| 400 | Validation error — missing/invalid fields |
| 401 | Not authenticated, or session invalid/expired/revoked |
| 403 | Authenticated, but not authorized for this action/record |
| 404 | Record not found |
| 409 | Conflict — wrong state for this action (already reversed, already disbursed, out-of-turn approval, etc.) |
| 413 | Payload too large (JSON body >2MB, or upload >5MB) |
| 429 | Rate limited (general 180/min/IP, or login-specific lockout after 5 failed attempts/15min) |
| 500 | Unexpected server error — generic message, logged server-side |
