const express = require('express');
const pool = require('../db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/audit — merged audit log from all sources
router.get('/', auth, requireRole('ict_manager', 'super_admin'), async (req, res) => {
  try {
    const { user_id, date_from, date_to, type, page = 1, limit = 25 } = req.query;
    const offset = (page - 1) * limit;

    // Build date + user filters as plain SQL snippets (applied per sub-query)
    const conditions = [];
    const params = [];
    let idx = 1;

    if (user_id)    { conditions.push(`al.user_id = $${idx++}`);                       params.push(user_id); }
    if (date_from)  { conditions.push(`al.created_at >= $${idx++}`);                   params.push(date_from); }
    if (date_to)    { conditions.push(`al.created_at <= $${idx++}`);                   params.push(date_to + ' 23:59:59'); }

    const baseWhere = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // ── 1. Ticket audit logs ────────────────────────────────────────────
    const ticketQuery = `
      SELECT
        al.id::text AS id,
        'ticket'    AS type,
        al.action,
        al.old_value,
        al.new_value,
        al.created_at,
        t.ticket_number  AS ref_number,
        t.subject        AS ref_subject,
        t.id::text       AS ref_id,
        u.full_name      AS user_name,
        u.role           AS user_role
      FROM audit_logs al
      LEFT JOIN tickets t ON al.ticket_id = t.id
      LEFT JOIN users   u ON al.user_id   = u.id
      ${baseWhere}
    `;

    // ── 2. SA audit logs ────────────────────────────────────────────────
    const saQuery = `
      SELECT
        al.id::text  AS id,
        'sa'         AS type,
        al.action,
        al.old_value,
        al.new_value,
        al.created_at,
        r.request_number AS ref_number,
        r.account_name   AS ref_subject,
        r.id::text       AS ref_id,
        u.full_name      AS user_name,
        u.role           AS user_role
      FROM sa_audit_logs al
      LEFT JOIN sa_requests r ON al.request_id = r.id
      LEFT JOIN users       u ON al.user_id    = u.id
      ${baseWhere}
    `;

    // ── 3. Login history ────────────────────────────────────────────────
    const loginBaseWhere = conditions.length
      ? 'WHERE ' + conditions.join(' AND ').replace(/al\./g, 'al.')
      : '';

    const loginQuery = `
      SELECT
        al.id::text       AS id,
        'login'           AS type,
        'User login'      AS action,
        NULL              AS old_value,
        al.ip_address     AS new_value,
        al.created_at,
        NULL              AS ref_number,
        NULL              AS ref_subject,
        NULL              AS ref_id,
        u.full_name       AS user_name,
        u.role            AS user_role
      FROM login_history al
      LEFT JOIN users u ON al.user_id = u.id
      ${loginBaseWhere}
    `;

    // ── Skip login sub-query if type filter excludes it ─────────────────
    let unionParts = [];
    if (!type || type === 'ticket') unionParts.push(ticketQuery);
    if (!type || type === 'sa')     unionParts.push(saQuery);
    if (!type || type === 'login')  unionParts.push(loginQuery);

    // If ticket_audit_logs has user_management entries (no ticket_id), they already come through ticketQuery
    const union = unionParts.join('\nUNION ALL\n');

    const countSql = `SELECT COUNT(*) FROM (${union}) merged`;
    const dataSql  = `
      SELECT * FROM (${union}) merged
      ORDER BY created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    const allParams      = [...params, ...params, ...params]; // one set per sub-query
    const paginateParams = [...params, ...params, ...params, parseInt(limit), parseInt(offset)];

    const [countResult, dataResult] = await Promise.all([
      pool.query(countSql,  allParams),
      pool.query(dataSql,   paginateParams),
    ]);

    res.json({
      logs:  dataResult.rows,
      total: parseInt(countResult.rows[0].count),
      page:  parseInt(page),
      pages: Math.ceil(countResult.rows[0].count / limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
