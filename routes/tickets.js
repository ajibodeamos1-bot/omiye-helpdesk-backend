const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { sendEmail, emailTemplates } = require('../emailService');

const router = express.Router();

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE) || 10) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|txt/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  },
});

// Custom SLA hours per category
const CATEGORY_SLA = {
  'ATM Transaction Error': 96, // 4 working days
};
const PRIORITY_SLA = { critical: 4, high: 8, medium: 24, low: 48 };

function getSLAHours(category, priority) {
  if (category === 'ATM Card Request') return null; // No SLA for card requests
  if (CATEGORY_SLA[category]) return CATEGORY_SLA[category];
  return PRIORITY_SLA[priority] || 24;
}

function getSLADeadline(category, priority) {
  const hours = getSLAHours(category, priority);
  if (!hours) return new Date('2099-12-31'); // Far future = effectively no SLA
  return new Date(Date.now() + hours * 3600000);
}

// Generate ticket number OMY-XXXX
async function generateTicketNumber() {
  // Use MAX to get the highest existing number to avoid duplicates
  const result = await pool.query(
    "SELECT ticket_number FROM tickets WHERE ticket_number LIKE 'OMY-%' ORDER BY created_at DESC LIMIT 1"
  );
  let num = 1;
  if (result.rows.length > 0) {
    const lastNum = parseInt(result.rows[0].ticket_number.replace('OMY-', '')) || 0;
    num = lastNum + 1;
  }
  return 'OMY-' + String(num).padStart(4, '0');
}

// GET /api/tickets
router.get('/', auth, async (req, res) => {
  try {
    const { status, priority, category, branch, search, department, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let where = [], params = [], idx = 1;

    if (req.user.role === 'care_rep') {
      where.push(`t.created_by = $${idx++}`); params.push(req.user.id);
    } else if (req.user.role === 'finance_officer') {
      where.push(`(t.created_by = $${idx++} OR t.department = 'finance')`); params.push(req.user.id);
    } else if (req.user.role === 'ict_staff') {
      where.push(`(t.assigned_to = $${idx++} OR t.department = 'ict' OR t.department IS NULL)`); params.push(req.user.id);
    } else if (req.user.role === 'branch_manager') {
      where.push(`t.branch = $${idx++}`); params.push(req.user.branch);
    }

    if (status) { where.push(`t.status = $${idx++}`); params.push(status); }
    if (priority) { where.push(`t.priority = $${idx++}`); params.push(priority); }
    if (category) { where.push(`t.category = $${idx++}`); params.push(category); }
    if (department) { where.push(`t.department = $${idx++}`); params.push(department); }
    if (search) {
      where.push(`(t.subject ILIKE $${idx} OR t.ticket_number ILIKE $${idx} OR t.description ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const countResult = await pool.query(`SELECT COUNT(*) FROM tickets t ${whereClause}`, params);
    const result = await pool.query(`
      SELECT t.*,
        c.full_name AS created_by_name, c.email AS created_by_email,
        a.full_name AS assigned_to_name,
        CASE WHEN t.sla_deadline < NOW() AND t.status NOT IN ('resolved','closed') THEN true ELSE false END AS sla_breached
      FROM tickets t
      LEFT JOIN users c ON t.created_by = c.id
      LEFT JOIN users a ON t.assigned_to = a.id
      ${whereClause}
      ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, t.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, limit, offset]);

    res.json({ tickets: result.rows, total: parseInt(countResult.rows[0].count), page: parseInt(page), pages: Math.ceil(countResult.rows[0].count / limit) });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// POST /api/tickets
router.post('/', auth, requireRole('care_rep', 'ict_staff', 'ict_manager', 'finance_officer', 'super_admin'), upload.array('attachments', 5), async (req, res) => {
  const { subject, description, category, priority, branch, affected_staff, department } = req.body;
  if (!subject || !description || !category || !priority || !branch)
    return res.status(400).json({ message: 'Missing required fields' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const slaDeadline = getSLADeadline(category, priority);
    const noSLA = category === 'ATM Card Request';
    const ticketNumber = await generateTicketNumber();

    const ticketResult = await client.query(`
      INSERT INTO tickets (ticket_number, subject, description, category, priority, branch, affected_staff, created_by, sla_deadline, department)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [ticketNumber, subject, description, category, priority, branch, affected_staff || null, req.user.id, slaDeadline, department || 'ict']);

    const ticket = ticketResult.rows[0];

    if (req.files?.length) {
      for (const file of req.files) {
        await client.query(
          'INSERT INTO attachments (ticket_id, original_name, stored_name, mime_type, file_size, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
          [ticket.id, file.originalname, file.filename, file.mimetype, file.size, req.user.id]
        );
      }
    }

    await client.query('INSERT INTO audit_logs (ticket_id, user_id, action) VALUES ($1,$2,$3)', [ticket.id, req.user.id, 'Ticket created']);
    await client.query('COMMIT');

    const creatorResult = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [req.user.id]);
    const creator = creatorResult.rows[0];

    const deptRole = department === 'finance' ? "'finance_officer'" : "'ict_staff','ict_manager'";
    const staffResult = await pool.query(`SELECT email FROM users WHERE role IN (${deptRole}) AND is_active = true`);
    for (const u of staffResult.rows) sendEmail(u.email, emailTemplates.ticketCreated(ticket, creator));
    sendEmail(creator.email, emailTemplates.ticketConfirmation(ticket, creator));

    res.status(201).json({ message: 'Ticket created', ticket });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ message: 'Server error' });
  } finally { client.release(); }
});

// GET /api/tickets/stats/dashboard
router.get('/stats/dashboard', auth, async (req, res) => {
  try {
    let filter = '', params = [];
    if (req.user.role === 'care_rep') { filter = 'WHERE created_by = $1'; params = [req.user.id]; }
    else if (req.user.role === 'finance_officer') { filter = "WHERE (created_by = $1 OR department = 'finance')"; params = [req.user.id]; }
    else if (req.user.role === 'branch_manager') { filter = 'WHERE branch = $1'; params = [req.user.branch]; }
    else if (req.user.role === 'ict_staff') { filter = "WHERE (assigned_to = $1 OR department = 'ict' OR department IS NULL)"; params = [req.user.id]; }

    const [open, inprog, resolvedToday, slaBreach, byStatus, byPriority, byCategory] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM tickets ${filter ? filter + " AND status NOT IN ('resolved','closed')" : "WHERE status NOT IN ('resolved','closed')"}`, params),
      pool.query(`SELECT COUNT(*) FROM tickets ${filter ? filter + " AND status = 'in_progress'" : "WHERE status = 'in_progress'"}`, params),
      pool.query(`SELECT COUNT(*) FROM tickets ${filter ? filter + " AND status = 'resolved' AND resolved_at >= CURRENT_DATE" : "WHERE status = 'resolved' AND resolved_at >= CURRENT_DATE"}`, params),
      pool.query(`SELECT COUNT(*) FROM tickets ${filter ? filter + " AND sla_deadline < NOW() AND status NOT IN ('resolved','closed')" : "WHERE sla_deadline < NOW() AND status NOT IN ('resolved','closed')"}`, params),
      pool.query(`SELECT status, COUNT(*) as count FROM tickets ${filter} GROUP BY status`, params),
      pool.query(`SELECT priority, COUNT(*) as count FROM tickets ${filter} GROUP BY priority`, params),
      pool.query(`SELECT category, COUNT(*) as count FROM tickets ${filter} GROUP BY category ORDER BY count DESC LIMIT 6`, params),
    ]);

    res.json({
      open: parseInt(open.rows[0].count),
      in_progress: parseInt(inprog.rows[0].count),
      resolved_today: parseInt(resolvedToday.rows[0].count),
      sla_breached: parseInt(slaBreach.rows[0].count),
      by_status: byStatus.rows,
      by_priority: byPriority.rows,
      by_category: byCategory.rows,
    });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// GET /api/tickets/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*,
        c.full_name AS created_by_name, c.email AS created_by_email, c.branch AS created_by_branch,
        a.full_name AS assigned_to_name, a.email AS assigned_to_email,
        CASE WHEN t.sla_deadline < NOW() AND t.status NOT IN ('resolved','closed') THEN true ELSE false END AS sla_breached
      FROM tickets t
      LEFT JOIN users c ON t.created_by = c.id
      LEFT JOIN users a ON t.assigned_to = a.id
      WHERE t.id = $1
    `, [req.params.id]);

    if (!result.rows.length) return res.status(404).json({ message: 'Ticket not found' });
    const ticket = result.rows[0];

    if (req.user.role === 'care_rep' && ticket.created_by !== req.user.id)
      return res.status(403).json({ message: 'Access denied' });

    const commentsQuery = (req.user.role === 'care_rep' || req.user.role === 'finance_officer')
      ? 'SELECT cm.*, u.full_name AS author_name, u.role AS author_role FROM comments cm LEFT JOIN users u ON cm.author_id = u.id WHERE cm.ticket_id = $1 AND cm.is_internal = false ORDER BY cm.created_at'
      : 'SELECT cm.*, u.full_name AS author_name, u.role AS author_role FROM comments cm LEFT JOIN users u ON cm.author_id = u.id WHERE cm.ticket_id = $1 ORDER BY cm.created_at';

    const [comments, attachments, audit] = await Promise.all([
      pool.query(commentsQuery, [req.params.id]),
      pool.query('SELECT a.*, u.full_name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON a.uploaded_by = u.id WHERE a.ticket_id = $1 ORDER BY a.created_at', [req.params.id]),
      pool.query('SELECT al.*, u.full_name AS user_name FROM audit_logs al LEFT JOIN users u ON al.user_id = u.id WHERE al.ticket_id = $1 ORDER BY al.created_at', [req.params.id]),
    ]);

    res.json({ ...ticket, comments: comments.rows, attachments: attachments.rows, audit: audit.rows });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// PUT /api/tickets/:id
router.put('/:id', auth, requireRole('ict_staff', 'ict_manager', 'finance_officer', 'super_admin'), async (req, res) => {
  const { status, assigned_to, priority, comment, is_internal } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
    if (!prev.rows.length) return res.status(404).json({ message: 'Ticket not found' });
    const old = prev.rows[0];

    const updates = [], params = [];
    let idx = 1;
    const auditActions = [];

    if (status && status !== old.status) {
      updates.push(`status = $${idx++}`); params.push(status);
      auditActions.push({ action: `Status changed: ${old.status} → ${status}`, old_value: old.status, new_value: status });
      if (status === 'resolved') { updates.push(`resolved_at = $${idx++}`); params.push(new Date()); }
      if (status === 'closed') { updates.push(`closed_at = $${idx++}`); params.push(new Date()); }
    }
    if (assigned_to !== undefined && assigned_to !== old.assigned_to) {
      updates.push(`assigned_to = $${idx++}`); params.push(assigned_to || null);
      const assigneeName = assigned_to ? (await pool.query('SELECT full_name FROM users WHERE id=$1', [assigned_to])).rows[0]?.full_name : 'Unassigned';
      auditActions.push({ action: `Assigned to: ${assigneeName}`, old_value: old.assigned_to, new_value: assigned_to });
    }
    if (priority && priority !== old.priority) {
      updates.push(`priority = $${idx++}`); params.push(priority);
      auditActions.push({ action: `Priority changed: ${old.priority} → ${priority}`, old_value: old.priority, new_value: priority });
    }

    let updatedTicket = old;
    if (updates.length) {
      params.push(req.params.id);
      const updated = await client.query(`UPDATE tickets SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`, params);
      updatedTicket = updated.rows[0];
    }

    for (const log of auditActions) {
      await client.query('INSERT INTO audit_logs (ticket_id, user_id, action, old_value, new_value) VALUES ($1,$2,$3,$4,$5)',
        [req.params.id, req.user.id, log.action, log.old_value, log.new_value]);
    }

    if (comment && comment.trim()) {
      const internal = is_internal && ['ict_staff','ict_manager','finance_officer','super_admin'].includes(req.user.role);
      await client.query('INSERT INTO comments (ticket_id, author_id, content, is_internal) VALUES ($1,$2,$3,$4)',
        [req.params.id, req.user.id, comment.trim(), internal]);
      await client.query('INSERT INTO audit_logs (ticket_id, user_id, action) VALUES ($1,$2,$3)',
        [req.params.id, req.user.id, internal ? 'Internal note added' : 'Public reply posted']);
    }

    await client.query('COMMIT');

    if (status && status !== old.status) {
      const [creatorRes, updaterRes] = await Promise.all([
        pool.query('SELECT full_name, email FROM users WHERE id=$1', [old.created_by]),
        pool.query('SELECT full_name FROM users WHERE id=$1', [req.user.id]),
      ]);
      const creator = creatorRes.rows[0];
      const updater = updaterRes.rows[0];
      if (creator) {
        if (status === 'resolved') {
          sendEmail(creator.email, emailTemplates.ticketResolved(updatedTicket, updater, comment));
        } else {
          sendEmail(creator.email, emailTemplates.ticketUpdated(updatedTicket, updater, `Status updated to: ${status.replace('_',' ')}`, comment));
        }
      }
    }

    res.json({ message: 'Ticket updated', ticket: updatedTicket });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err); res.status(500).json({ message: 'Server error' });
  } finally { client.release(); }
});

module.exports = router;
