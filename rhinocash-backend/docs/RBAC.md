# RBAC & Access Model

Every user's final access is the composition the spec asked for:

```
SYSTEM ROLE + ACCESS LEVEL + BRANCH/REGION SCOPE + MODULE PERMISSIONS + ACTION PERMISSIONS = FINAL ACCESS
```

This is computed in `src/rbac.js` and enforced in `src/middleware.js` on
**every** protected route — not just used to decide what the frontend shows.
`computeFinalAccess(user)` returns the whole composition for a given user
(this is what the Admin's "Final Access" view in the UI would call).

## Roles

Exactly nine, never merged: `loan_officer`, `manager`, `regional_manager`,
`operational_manager`, `accountant`, `admin`, `ceo`, `director`, and
`investor` (investor is a structurally separate principal type — see
below — not a ninth row in the `users` table).

## Access levels

Suggested per role at creation time (`role.default_access_level` in the
`roles` table), editable per user:

| Role | Default Access Level |
|---|---|
| Loan Officer | Portfolio Access |
| Manager | Branch Management Access |
| Regional Manager | Regional Management Access |
| Operational Manager | Operations & Branch Expansion Access |
| Accountant | Accounting & Financial Access |
| Admin | Master System Administration Access |
| CEO | Executive Management Access |
| Director | Strategic & Governance Access |

## Branch / region scope

`rbac.branchIdsInScope(user)` returns the list of branch ids a user may
operate within, or `null` for company-wide roles:

- **Admin, CEO, Director, Accountant, Operational Manager** — company-wide (`null`)
- **Regional Manager** — every branch in their assigned region
- **Manager, Loan Officer** — their own single branch only

`rbac.isBranchAllowed(user, branchId)` and `rbac.assertRecordInScope(user,
branchId, label)` are the two functions every route uses to check a
**specific record** (not just filter a list) — see "Object-level checks"
below.

`rbac.resolveWriteBranchId(user, requestedBranchId)` is what stops a
restricted user from planting a record under a branch they don't own: for
Manager/Loan Officer it ignores the request body entirely and returns their
own branch; for Regional Manager it accepts the request only if it's inside
their region; unrestricted roles are trusted.

## Module permissions

The modules a role can see at all (`role_modules` table, seeded in
`seed.js`). A user's **effective** modules are their role's baseline
intersected with any personal restriction an Admin has set via
`PUT /api/users/:id/module-access` — restricting never expands beyond the
role baseline, only narrows it.

Modules: `dashboard`, `clients`, `loanbook`, `payments`, `accounting`,
`reports`, `staff`, `audit`, `support`, `account`.

## Action permissions

`permissions` table + `role_permissions` (baseline per role) +
`user_permission_overrides` (personal, takes priority). Current set:
`approve_loans`, `disburse_loans`, `record_payments`, `reverse_payment`,
`post_accounting_entries`, `manage_users`, `manage_branches`,
`open_new_branch`, `write_off_loans`, `manage_system_settings`.

`rbac.hasPermission(user, permissionId)` checks the override first, then
falls back to the role default.

## Object-level checks (not just list filtering)

Every `GET /:id`, `PATCH /:id`, and action route (approve, disburse,
reverse, restructure, write-off, record a payment) calls
`assertRecordInScope` against the actual record's `branch_id` — a Nairobi
Manager gets a 403 fetching a Kisumu client by ID directly, not just a
filtered-out row in a list. See `test/v2.test.js` section 1 for the exact
scenarios this is tested against.

## The Admin/CEO/Director split

Admin is the only role with unrestricted `manage_users`. CEO and Director
also hold `manage_users` (so they can reach the staff endpoints at all) but
every sensitive sub-action is additionally hard-restricted to
`role_id === 'admin'` in code — a single boolean permission can't express
"yes, but not on Admin accounts, and not password resets/session
revocation/module overrides":

| Action | Admin | CEO | Director |
|---|---|---|---|
| Create/edit ordinary staff (not Admin/CEO/Director) | Yes | Yes | Yes |
| Create/edit an Admin/CEO/Director account | Yes | No | No |
| Activate / Suspend a staff account | Yes | Yes | No |
| Deactivate a staff account | Yes | No | No |
| Set module-access overrides | Yes | No | No |
| Set/clear permission overrides | Yes | No | No |
| Reset access to role defaults | Yes | No | No |
| Reset a password | Yes | No | No |
| Revoke sessions | Yes | No | No |
| Edit the role permission matrix | Yes | No | No |

(`rbac.canActOnStaffRecord(actor, targetRoleId)` is the role-tier check;
`requireAdminOnly(...)` in `users.js`/`auth.js` is the sub-action gate.)

## Investors are a separate principal type, not a role

Investors are **not** rows in `users` and have no `role_id`. They
authenticate through a dedicated `/api/investor-auth/login` endpoint, get a
differently-shaped token (`{ type: 'investor', sub: investorId }`), and
every investor route derives the investor id **from that token**, never
from a client-supplied id. This is what actually makes cross-investor
access impossible — not a filter that could be forgotten on one page.
Staff-only middleware (`requireAuth`) structurally rejects an investor
token because it has no `role_id` to look up.

## Sequential loan approval as data, not code

`approval_workflow_steps` (step_order, role_id, status_label) defines the
4-step chain. `loans.current_step` tracks where a given loan is. A role can
only act when `currentStep.role_id === actor.role_id` **and** the loan's
branch is in the actor's scope **and** the actor didn't submit the loan
themselves. See `src/routes/loans.js: assertCanActOnLoan`.

## Branch opening authority

Operational Manager (or Admin) proposes via `POST /api/branch-proposals`;
only Admin or CEO can approve/reject, and never the person who proposed it.
Approval is the only path that creates a real `branches` row — see
`src/routes/branches.js`.
