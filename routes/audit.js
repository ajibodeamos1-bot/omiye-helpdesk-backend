const express = require('express');
const pool = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/audit - get all audit logs with filters
router.get('/', auth, requireRole('ict_manager', 'super_admin'), async (req, res) => {
  try {
    const { user_id, ticket_number, date_from, date_to, page = 1, limit = 25 } = req.query;
    const offset = (page - 1) * limit;

    let where = [];
    let params = [];
    let idx = 1;

    if (user_id) { where.push(`al.user_id = $${idx++}`); params.push(user_id); }
    if (ticket_number) { where.push(`t.ticket_number ILIKE $${idx++}`); params.push(`%${ticket_number}%`); }
    if (date_from) { where.push(`al.created_at >= $${idx++}`); params.push(date_from); }
    if (date_to) { where.push(`al.created_at <= $${idx++}`); params.push(date_to + ' 23:59:59'); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM audit_logs al
       LEFT JOIN tickets t ON al.ticket_id = t.id
       ${whereClause}`, params
    );

    const result = await pool.query(`
      SELECT 
        al.id, al.action, al.old_value, al.new_value, al.created_at,
        t.ticket_number, t.subject AS ticket_subject,
        u.full_name AS user_name, u.role AS user_role
      FROM audit_logs al
      LEFT JOIN tickets t ON al.ticket_id = t.id
      LEFT JOIN users u ON al.user_id = u.id
      ${whereClause}
      ORDER BY al.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, limit, offset]);

    res.json({
      logs: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      pages: Math.ceil(countResult.rows[0].count / limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
