const express = require('express');
const path = require('path');
const pool = require('../db');
const { auth } = require('../middleware/auth');
const { sendEmail, emailTemplates } = require('../emailService');
const { upload } = require('../cloudinary');

const router = express.Router({ mergeParams: true });

// POST /api/tickets/:ticketId/comments
router.post('/', auth, upload.array('attachments', 3), async (req, res) => {
  const { content, is_internal } = req.body;
  if (!content?.trim()) return res.status(400).json({ message: 'Comment content required' });

  const internal = (is_internal === 'true' || is_internal === true) &&
    ['ict_staff','ict_manager','finance_officer','super_admin'].includes(req.user.role);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const commentResult = await client.query(
      'INSERT INTO comments (ticket_id, author_id, content, is_internal) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.ticketId, req.user.id, content.trim(), internal]
    );
    const comment = commentResult.rows[0];

    // Save Cloudinary attachments
    if (req.files?.length) {
      for (const file of req.files) {
        const storedName = file.filename || file.path || file.originalname;
        await client.query(
          'INSERT INTO attachments (ticket_id, comment_id, original_name, stored_name, mime_type, file_size, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [req.params.ticketId, comment.id, file.originalname, storedName, file.mimetype, file.size, req.user.id]
        );
      }
    }

    await client.query(
      'INSERT INTO audit_logs (ticket_id, user_id, action) VALUES ($1,$2,$3)',
      [req.params.ticketId, req.user.id, internal ? 'Internal note added' : 'Public reply posted']
    );

    await client.query('COMMIT');

    if (!internal) {
      const ticketRes = await pool.query(
        'SELECT t.*, u.full_name AS created_by_name, u.email AS created_by_email FROM tickets t LEFT JOIN users u ON t.created_by = u.id WHERE t.id = $1',
        [req.params.ticketId]
      );
      const ticket = ticketRes.rows[0];
      const authorRes = await pool.query('SELECT full_name FROM users WHERE id=$1', [req.user.id]);
      const author = authorRes.rows[0];
      if (ticket?.created_by_email && ticket.created_by !== req.user.id) {
        sendEmail(ticket.created_by_email, emailTemplates.ticketUpdated(ticket, author, 'New reply posted', content));
      }
    }

    res.status(201).json({ message: 'Comment posted', comment });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally { client.release(); }
});

module.exports = router;
