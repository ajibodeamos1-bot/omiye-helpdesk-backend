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
      SELECT u.id, u.full_name, u.email, u.role, u.branch,
        COUNT(t.id) FILTER (WHERE t.status NOT IN ('resolved','closed')) AS active_tickets,
        COUNT(t.id) FILTER (WHERE t.status IN ('resolved','closed')) AS resolved_tickets,
        COUNT(t.id) FILTER (WHERE t.sla_deadline < NOW() AND t.status NOT IN ('resolved','closed')) AS overdue_tickets,
        ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/3600) FILTER (WHERE t.resolved_at IS NOT NULL), 1) AS avg_resolution_hrs
      FROM users u
      LEFT JOIN tickets t ON t.assigned_to = u.id
      WHERE u.role NOT IN ('sa_initiator', 'sa_approver')
      AND u.is_active = true
      GROUP BY u.id ORDER BY active_tickets DESC, resolved_tickets DESC
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
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000); // 20 minutes
    const result = await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role, branch, must_change_password, assigned_approver_id, password_expires_at) VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING id, full_name, email, role, branch',
      [full_name, email, password_hash, role, branch, assigned_approver_id || null, expiresAt]
    );
    const newUser = result.rows[0];
    await pool.query(
      'INSERT INTO audit_logs (user_id, action, new_value) VALUES ($1,$2,$3)',
      [req.user.id, `User created: ${full_name} (${role})`, email]
    ).catch(() => {});
    const { sendEmail, emailTemplates } = require('../emailService');
    const expiresAtFormatted = expiresAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
    sendEmail(newUser.email, emailTemplates.welcomeUser(newUser, password, expiresAtFormatted));
    res.status(201).json({ message: 'User created', user: newUser });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// PUT /api/users/:id — update user
router.put('/:id', auth, requireRole('super_admin'), async (req, res) => {
  const { full_name, role, branch, is_active, assigned_approver_id } = req.body;
  try {
    const old = await pool.query('SELECT full_name, role, branch, is_active FROM users WHERE id=$1', [req.params.id]);
    const result = await pool.query(
      'UPDATE users SET full_name=$1, role=$2, branch=$3, is_active=$4, assigned_approver_id=$5 WHERE id=$6 RETURNING id, full_name, email, role, branch, is_active',
      [full_name, role, branch, is_active, assigned_approver_id || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ message: 'User not found' });
    const updated = result.rows[0];
    await pool.query(
      'INSERT INTO audit_logs (user_id, action, old_value, new_value) VALUES ($1,$2,$3,$4)',
      [req.user.id, `User updated: ${updated.full_name}`, `role:${old.rows[0]?.role}`, `role:${role}`]
    ).catch(() => {});
    res.json({ message: 'User updated', user: updated });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// DELETE /api/users/:id
router.delete('/:id', auth, requireRole('super_admin'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ message: 'Cannot delete your own account' });
    const target = await pool.query('SELECT full_name, email, role FROM users WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    if (target.rows.length) {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, old_value) VALUES ($1,$2,$3)',
        [req.user.id, `User deleted: ${target.rows[0].full_name} (${target.rows[0].role})`, target.rows[0].email]
      ).catch(() => {});
    }
    res.json({ message: 'User deleted' });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// POST /api/users/:id/reset-password
router.post('/:id/reset-password', auth, requireRole('super_admin'), async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(new_password, 10);
    const expiresAt = new Date(Date.now() + 20 * 60 * 1000); // 20 minutes from now
    await pool.query(
      'UPDATE users SET password_hash=$1, must_change_password=true, password_expires_at=$2 WHERE id=$3',
      [hash, expiresAt, req.params.id]
    );
    const target = await pool.query('SELECT full_name, email FROM users WHERE id=$1', [req.params.id]);
    const user = target.rows[0];
    if (user) {
      const { sendEmail, emailTemplates } = require('../emailService');
      const expiresAtFormatted = expiresAt.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
      sendEmail(user.email, emailTemplates.passwordResetByAdmin(user, new_password, expiresAtFormatted));
    }
    await pool.query(
      'INSERT INTO audit_logs (user_id, action) VALUES ($1,$2)',
      [req.user.id, `Password reset for: ${user?.full_name || req.params.id}`]
    ).catch(() => {});
    res.json({ message: 'Password reset successfully. User has been notified by email.' });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
