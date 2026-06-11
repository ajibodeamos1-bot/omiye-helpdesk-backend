const express = require('express');
const pool = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications — fetch unread notifications for current user
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT n.*, t.ticket_number, t.subject AS ticket_subject
      FROM notifications n
      LEFT JOIN tickets t ON n.ticket_id = t.id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT 30
    `, [req.user.id]);
    const unread = result.rows.filter(r => !r.is_read).length;
    res.json({ notifications: result.rows, unread });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// PUT /api/notifications/read-all — mark all as read
router.put('/read-all', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.user.id]);
    res.json({ message: 'All marked as read' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// PUT /api/notifications/:id/read — mark one as read
router.put('/:id/read', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Marked as read' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;
