// staffRegion.js — staff work in their branch's region. Whenever a branch
// moves to another region, or someone is transferred or promoted to another
// branch, their region follows the branch. A Regional Manager is the one
// exception: their region is their own, chosen for them, never taken from a
// branch.
'use strict';
const { run } = require('./db');

// Brings users' region in line with their branch; narrowed to one user or
// one branch when given. Returns how many records changed.
async function syncStaffRegions({ userId, branchId } = {}) {
  const where = []; const params = [];
  if (userId) { where.push('u.id = ?'); params.push(userId); }
  if (branchId) { where.push('b.id = ?'); params.push(branchId); }
  const r = await run(`UPDATE users u SET region_id = b.region_id FROM branches b
    WHERE u.branch_id = b.id AND u.role_id <> 'regional_manager' AND b.region_id IS NOT NULL AND u.region_id IS DISTINCT FROM b.region_id
    ${where.length ? 'AND ' + where.join(' AND ') : ''}`, params);
  return (r && (r.changes ?? r.rowCount)) || 0;
}

module.exports = { syncStaffRegions };
