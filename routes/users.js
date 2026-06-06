const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/users
router.get('/', auth, requireRole('ict_manager','super_admin'), async (req, res) => {
  try {
    const { search, role, branch } = req.query;
    let where = [], params = [], idx = 1;
    if (search) { where.push(`(full_name ILIKE $${idx} OR email ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (role) { where.push(`role = $${idx++}`); params.push(role); }
    if (branch) { where.push(`branch = $${idx++}`); params.push(branch); }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const result = await pool.query(
      `SELECT id, full_name, email, role, branch, is_active, must_change_password, assigned_approver_id, created_at FROM users ${whereClause} ORDER BY full_name`,
      params
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// GET /api/users/assignable — for ticket assignment (ICT + Finance staff)
router.get('/assignable', auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, full_name, role, branch FROM users WHERE role IN ('ict_staff','ict_manager','finance_officer','super_admin') AND is_active = true ORDER BY full_name"
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// GET /api/users/sa-approvers — list all sa_approvers for dropdown
router.get('/sa-approvers', auth, requireRole('super_admin'), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, full_name, email, branch FROM users WHERE role = 'sa_approver' AND is_active = true ORDER BY full_name"
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// GET /api/users/workload
router.get('/workload', auth, requireRole('ict_manager','super_admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.full_name, u.role,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('resolved','closed')) AS active_tickets,
        COUNT(t.id) FILTER (WHERE t.status IN ('resolved','closed')) AS resolved_tickets
      FROM users u
      LEFT JOIN tickets t ON t.assigned_to = u.id
      WHERE u.role IN ('ict_staff','ict_manager','finance_officer')
      GROUP BY u.id ORDER BY active_tickets DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// POST /api/users — create user
router.post('/', auth, requireRole('super_admin'), async (req, res) => {
  const { full_name, email, password, role, branch, assigned_approver_id } = req.body;
  if (!full_name || !email || !password || !role || !branch)
    return res.status(400).json({ message: 'All fields required' });
  try {
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length) return res.status(409).json({ message: 'Email already registered' });
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role, branch, must_change_password, assigned_approver_id) VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id, full_name, email, role, branch',
      [full_name, email, password_hash, role, branch, assigned_approver_id || null]
    );
    const newUser = result.rows[0];
    // Send welcome email
    const { sendEmail, emailTemplates } = require('../emailService');
    sendEmail(newUser.email, emailTemplates.welcomeUser(newUser, password));
    res.status(201).json({ message: 'User created', user: newUser });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// PUT /api/users/:id — update user
router.put('/:id', auth, requireRole('super_admin'), async (req, res) => {
  const { full_name, role, branch, is_active, assigned_approver_id } = req.body;
  try {
    const result = await pool.query(
      'UPDATE users SET full_name=$1, role=$2, branch=$3, is_active=$4, assigned_approver_id=$5 WHERE id=$6 RETURNING id, full_name, email, role, branch, is_active',
      [full_name, role, branch, is_active, assigned_approver_id || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User updated', user: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// DELETE /api/users/:id
router.delete('/:id', auth, requireRole('super_admin'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ message: 'Cannot delete your own account' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ message: 'User deleted' });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// POST /api/users/:id/reset-password
router.post('/:id/reset-password', auth, requireRole('super_admin'), async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash=$1, must_change_password=true WHERE id=$2', [hash, req.params.id]);
    res.json({ message: 'Password reset successfully' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
