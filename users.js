const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/users
router.get('/', auth, requireRole('ict_manager', 'super_admin'), async (req, res) => {
  try {
    const { role, branch, search, is_active } = req.query;
    let where = [], params = [], idx = 1;
    if (role) { where.push(`role = $${idx++}`); params.push(role); }
    if (branch) { where.push(`branch = $${idx++}`); params.push(branch); }
    if (is_active !== undefined) { where.push(`is_active = $${idx++}`); params.push(is_active === 'true'); }
    if (search) { where.push(`(full_name ILIKE $${idx} OR email ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const result = await pool.query(
      `SELECT id, full_name, email, role, branch, is_active, created_at FROM users ${whereClause} ORDER BY full_name`,
      params
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// GET /api/users/assignable - all staff that can be assigned tickets (ICT + Finance)
router.get('/assignable', auth, requireRole('ict_staff', 'ict_manager', 'finance_officer', 'super_admin'), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, full_name, email, role, branch FROM users WHERE role IN ('ict_staff','ict_manager','finance_officer') AND is_active = true ORDER BY full_name"
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// GET /api/users/ict
router.get('/ict', auth, requireRole('ict_staff', 'ict_manager', 'finance_officer', 'super_admin'), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, full_name, email, branch, role FROM users WHERE role IN ('ict_staff','ict_manager','finance_officer') AND is_active = true ORDER BY full_name"
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// GET /api/users/workload/ict
router.get('/workload/ict', auth, requireRole('ict_manager', 'super_admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.role,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('resolved','closed')) AS active_tickets,
        COUNT(t.id) FILTER (WHERE t.status = 'resolved') AS resolved_tickets,
        COUNT(t.id) FILTER (WHERE t.sla_deadline < NOW() AND t.status NOT IN ('resolved','closed')) AS overdue_tickets,
        ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/3600) FILTER (WHERE t.resolved_at IS NOT NULL), 1) AS avg_resolution_hrs
      FROM users u
      LEFT JOIN tickets t ON t.assigned_to = u.id
      WHERE u.role IN ('ict_staff','ict_manager','finance_officer') AND u.is_active = true
      GROUP BY u.id, u.full_name, u.email, u.role
      ORDER BY active_tickets DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// GET /api/users/:id
router.get('/:id', auth, requireRole('ict_manager', 'super_admin'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, full_name, email, role, branch, is_active, created_at FROM users WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// PUT /api/users/:id
router.put('/:id', auth, requireRole('super_admin'), async (req, res) => {
  const { full_name, role, branch, is_active, password } = req.body;
  try {
    const updates = [], params = []; let idx = 1;
    if (full_name) { updates.push(`full_name = $${idx++}`); params.push(full_name); }
    if (role) { updates.push(`role = $${idx++}`); params.push(role); }
    if (branch) { updates.push(`branch = $${idx++}`); params.push(branch); }
    if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); params.push(is_active); }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      updates.push(`password_hash = $${idx++}`); params.push(hash);
      updates.push(`must_change_password = $${idx++}`); params.push(true);
    }
    if (!updates.length) return res.status(400).json({ message: 'No updates provided' });
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, full_name, email, role, branch, is_active`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User updated', user: result.rows[0] });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// DELETE /api/users/:id
router.delete('/:id', auth, requireRole('super_admin'), async (req, res) => {
  try {
    const check = await pool.query('SELECT role FROM users WHERE id = $1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ message: 'User not found' });
    if (check.rows[0].role === 'super_admin') return res.status(403).json({ message: 'Cannot delete a Super Admin account' });
    if (req.params.id === req.user.id) return res.status(403).json({ message: 'You cannot delete your own account' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ message: 'User deleted successfully' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// POST /api/users/:id/reset-password (Super Admin resets any user password)
router.post('/:id/reset-password', auth, requireRole('super_admin'), async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2', [hash, req.params.id]);
    res.json({ message: 'Password reset successfully. User will be prompted to change it on next login.' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
