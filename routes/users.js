const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/users - list all users (admin/manager)
router.get('/', auth, requireRole('ict_manager', 'super_admin'), async (req, res) => {
  try {
    const { role, branch, search, is_active } = req.query;
    let where = []; let params = []; let idx = 1;
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
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/users/ict - list ICT staff for assignment dropdown
router.get('/ict', auth, requireRole('ict_manager', 'super_admin'), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, full_name, email, branch FROM users WHERE role IN ('ict_staff','ict_manager') AND is_active = true ORDER BY full_name"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
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
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/users/:id - update user (admin only)
router.put('/:id', auth, requireRole('super_admin'), async (req, res) => {
  const { full_name, role, branch, is_active, password } = req.body;
  try {
    const updates = []; const params = []; let idx = 1;
    if (full_name) { updates.push(`full_name = $${idx++}`); params.push(full_name); }
    if (role) { updates.push(`role = $${idx++}`); params.push(role); }
    if (branch) { updates.push(`branch = $${idx++}`); params.push(branch); }
    if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); params.push(is_active); }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      updates.push(`password_hash = $${idx++}`); params.push(hash);
    }
    if (!updates.length) return res.status(400).json({ message: 'No updates provided' });
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, full_name, email, role, branch, is_active`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User updated', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/users/workload/ict - ICT team workload stats
router.get('/workload/ict', auth, requireRole('ict_manager', 'super_admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.full_name, u.email,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('resolved','closed')) AS active_tickets,
        COUNT(t.id) FILTER (WHERE t.status = 'resolved') AS resolved_tickets,
        COUNT(t.id) FILTER (WHERE t.sla_deadline < NOW() AND t.status NOT IN ('resolved','closed')) AS overdue_tickets,
        ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/3600) FILTER (WHERE t.resolved_at IS NOT NULL), 1) AS avg_resolution_hrs
      FROM users u
      LEFT JOIN tickets t ON t.assigned_to = u.id
      WHERE u.role IN ('ict_staff','ict_manager') AND u.is_active = true
      GROUP BY u.id, u.full_name, u.email
      ORDER BY active_tickets DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
