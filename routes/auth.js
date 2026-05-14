const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const pool = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { sendEmail, emailTemplates } = require('../emailService');

const router = express.Router();

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ message: 'Invalid email or password' });
    if (!user.is_active) return res.status(403).json({ message: 'Account is deactivated. Contact admin.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ message: 'Invalid email or password' });

    // Log login
    await pool.query(
      'INSERT INTO login_history (user_id, ip_address) VALUES ($1, $2)',
      [user.id, req.ip || req.headers['x-forwarded-for'] || 'unknown']
    ).catch(() => {}); // don't fail if table doesn't exist yet

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name, branch: user.branch, must_change_password: user.must_change_password },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role, branch: user.branch, must_change_password: user.must_change_password }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/register (Super Admin only)
router.post('/register', auth, requireRole('super_admin'), [
  body('full_name').trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('role').isIn(['care_rep', 'ict_staff', 'ict_manager', 'branch_manager', 'super_admin']),
  body('branch').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { full_name, email, password, role, branch } = req.body;
  try {
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) return res.status(409).json({ message: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (full_name, email, password_hash, role, branch, must_change_password) VALUES ($1,$2,$3,$4,$5,true) RETURNING id, full_name, email, role, branch',
      [full_name, email, password_hash, role, branch]
    );
    const newUser = result.rows[0];
    sendEmail(newUser.email, emailTemplates.welcomeUser(newUser, password));
    res.status(201).json({ message: 'User created. Welcome email sent to ' + newUser.email, user: newUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, full_name, email, role, branch, is_active, must_change_password, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/auth/change-password
router.put('/change-password', auth, [
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { current_password, new_password } = req.body;
  try {
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(current_password, result.rows[0].password_hash);
    if (!valid) return res.status(400).json({ message: 'Current password is incorrect' });

    const new_hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [new_hash, req.user.id]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/auth/profile - update own profile
router.put('/profile', auth, [
  body('full_name').trim().notEmpty(),
], async (req, res) => {
  const { full_name } = req.body;
  try {
    const result = await pool.query(
      'UPDATE users SET full_name = $1 WHERE id = $2 RETURNING id, full_name, email, role, branch',
      [full_name, req.user.id]
    );
    res.json({ message: 'Profile updated', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: 'Invalid email' });

  const { email } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1 AND is_active = true', [email]);
    // Always return success to prevent email enumeration
    if (!result.rows.length) {
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }
    const user = result.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await pool.query(
      'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET token = $2, expires_at = $3',
      [user.id, token, expires]
    );

    sendEmail(user.email, emailTemplates.passwordReset(user, token));
    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', [
  body('token').notEmpty(),
  body('new_password').isLength({ min: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ message: 'Invalid request' });

  const { token, new_password } = req.body;
  try {
    const result = await pool.query(
      'SELECT pr.*, u.email FROM password_resets pr JOIN users u ON pr.user_id = u.id WHERE pr.token = $1 AND pr.expires_at > NOW()',
      [token]
    );
    if (!result.rows.length) return res.status(400).json({ message: 'Reset link is invalid or has expired.' });

    const reset = result.rows[0];
    const new_hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [new_hash, reset.user_id]);
    await pool.query('DELETE FROM password_resets WHERE user_id = $1', [reset.user_id]);
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/auth/login-history (Super Admin only)
router.get('/login-history', auth, requireRole('super_admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT lh.*, u.full_name, u.email, u.role 
      FROM login_history lh 
      JOIN users u ON lh.user_id = u.id 
      ORDER BY lh.created_at DESC 
      LIMIT 100
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
