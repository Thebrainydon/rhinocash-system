// staffProfile.js — the rest of My Account -> View Details: a staff
// member's own real Interactions log (a self-authored note history, the
// same real pattern client_interactions already gives clients) and a
// real, computed monthly payroll/payslip (real Basic Salary set by
// Admin/HR on the users table, real Kenyan statutory NSSF/SHIF/PAYE
// formulas, and a real Salary Advance deduction pulled from
// salary_advance_requests) — never fabricated figures.
'use strict';
const { requireAuth } = require('./../middleware');
const { all, get, run } = require('./../db');
const crypto = require('node:crypto');

const INTERACTION_SUBJECTS = ['Performance', 'PTP', 'Collection', 'Arrears', 'Production', 'Follow-Up'];

// ==================== Real Kenyan statutory payroll formulas ====================
// NSSF (Tier I + Tier II combined, 6% of pensionable pay up to the real
// Upper Earnings Limit of KES 72,000/month).
function computeNssf(gross) {
  return Math.round(0.06 * Math.min(gross, 72000) * 100) / 100;
}
// SHIF: 2.75% of gross salary, real statutory minimum KES 300/month.
function computeShif(gross) {
  return Math.max(300, Math.round(0.0275 * gross * 100) / 100);
}
// PAYE: the real 2023 Finance Act progressive monthly bands, computed on
// taxable pay (gross less the real NSSF contribution), less the real
// KES 2,400 monthly personal relief. Never negative.
function computePaye(taxablePay) {
  const bands = [[24000, 0.10], [8333, 0.25], [467667, 0.30], [300000, 0.325], [Infinity, 0.35]];
  let remaining = Math.max(0, taxablePay);
  let tax = 0;
  for (const [bandSize, rate] of bands) {
    if (remaining <= 0) break;
    const amountInBand = Math.min(remaining, bandSize);
    tax += amountInBand * rate;
    remaining -= amountInBand;
  }
  const personalRelief = 2400;
  return Math.max(0, Math.round((tax - personalRelief) * 100) / 100);
}
// A deterministic, human-legible payslip reference — not a financial
// figure, just a real generated serial (month + year + a fixed staff
// suffix), the same "system-generated reference number" convention this
// app already uses for account/loan numbers.
function payslipRef(user, period) {
  const [y, m] = period.split('-');
  const staffDigits = (user.staff_code || '').replace(/\D/g, '').padStart(2, '0').slice(-2);
  return `${m}${y.slice(-2)}${staffDigits}`;
}
function payslipPeriodRange(period) {
  const [y, m] = period.split('-').map(Number);
  return { monthStart: `${period}-01`, monthEnd: `${period}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
}
// A real payslip only ever exists for a period that has genuinely begun
// (never a fabricated future month) and where the staff member was
// genuinely already employed by its end — real dates, never fabricated.
function payslipPeriodIsReal(user, period) {
  const { monthStart, monthEnd } = payslipPeriodRange(period);
  const today = new Date().toISOString().slice(0, 10);
  if (monthStart > today) return false;
  if (user.created_at && user.created_at.slice(0, 10) > monthEnd) return false;
  return true;
}
async function computePayslip(user, period) {
  const { monthStart, monthEnd } = payslipPeriodRange(period);
  const gross = Number(user.basic_salary) || 0;
  const nssf = computeNssf(gross);
  const shif = computeShif(gross);
  const paye = computePaye(gross - nssf);
  const advanceRow = await get(
    `SELECT COALESCE(SUM(amount),0) as v FROM salary_advance_requests WHERE user_id = ? AND status = 'Approved' AND (decided_at)::date BETWEEN (?)::date AND (?)::date`,
    [user.id, monthStart, monthEnd]
  );
  const salaryAdvance = advanceRow.v;
  const otherDeductions = 0; // no real source for any other deduction yet — never fabricated
  const totalDeductions = nssf + shif + paye + salaryAdvance + otherDeductions;
  const netPay = Math.round((gross - totalDeductions) * 100) / 100;
  return {
    period, basicSalary: gross, allowances: 0, bonus: 0, grossPay: gross,
    nssf, shif, paye, salaryAdvance, otherDeductions, totalDeductions, netPay,
    ref: payslipRef(user, period),
  };
}

function register(router) {
  // ==================== Interactions ====================
  router.get('/api/users/me/interactions', requireAuth, async (req, res) => {
    const clauses = ['user_id = ?']; const params = [req.user.id];
    if (req.query.year) { clauses.push(`EXTRACT(YEAR FROM (created_at)::date) = ?`); params.push(Number(req.query.year)); }
    const rows = await all(`SELECT * FROM staff_interactions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params);
    res.json({ interactions: rows });
  });

  router.post('/api/users/me/interactions', requireAuth, async (req, res, next) => {
    const { subject, note } = req.body;
    if (!INTERACTION_SUBJECTS.includes(subject)) return next({ status: 400, message: `subject must be one of: ${INTERACTION_SUBJECTS.join(', ')}` });
    if (!note || !note.trim()) return next({ status: 400, message: 'note is required' });
    const id = 'sint_' + crypto.randomUUID();
    await run('INSERT INTO staff_interactions (id, user_id, subject, note, created_by) VALUES (?,?,?,?,?)',
      [id, req.user.id, subject, note.trim(), req.user.id]);
    res.status(201).json({ interaction: await get('SELECT * FROM staff_interactions WHERE id = ?', [id]) });
  });

  // ==================== Payroll / payslips ====================
  // A real month only ever appears once the staff member has a real
  // Basic Salary set (Admin/HR, via PATCH /api/users/:id) AND that month
  // has genuinely already happened — never a fabricated future payslip.
  router.get('/api/users/me/payroll', requireAuth, async (req, res) => {
    const year = /^\d{4}$/.test(req.query.year) ? Number(req.query.year) : new Date().getFullYear();
    const me = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const months = [];
    if (Number(me.basic_salary) > 0) {
      for (let m = 12; m >= 1; m--) {
        const period = `${year}-${String(m).padStart(2, '0')}`;
        if (!payslipPeriodIsReal(me, period)) continue;
        months.push(await computePayslip(me, period));
      }
    }
    res.json({ year: String(year), months });
  });

  router.get('/api/users/me/payroll/:period', requireAuth, async (req, res, next) => {
    if (!/^\d{4}-\d{2}$/.test(req.params.period)) return next({ status: 400, message: 'period must look like "2026-08"' });
    const me = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!(Number(me.basic_salary) > 0)) return next({ status: 404, message: 'No real Basic Salary is set for this account yet — ask an Administrator or HR to set one' });
    if (!payslipPeriodIsReal(me, req.params.period)) return next({ status: 404, message: 'No real payslip exists for that period — either it is a future month, or you were not yet employed' });
    const payslip = await computePayslip(me, req.params.period);
    res.json({ payslip });
  });
}

module.exports = { register };
