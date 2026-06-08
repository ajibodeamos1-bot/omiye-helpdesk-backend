const express = require('express');
const pool = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { upload } = require('../cloudinary');
const { sendEmail } = require('../emailService');

const router = express.Router();

// Generate SA request number
async function generateSANumber() {
  const result = await pool.query(
    "SELECT request_number FROM sa_requests WHERE request_number LIKE 'SA-%' ORDER BY created_at DESC LIMIT 1"
  );
  let num = 1;
  if (result.rows.length > 0) {
    const last = parseInt(result.rows[0].request_number.replace('SA-', '')) || 0;
    num = last + 1;
  }
  return 'SA-' + String(num).padStart(4, '0');
}

// Format currency
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(amount);
}

// GET /api/sa - list requests based on role
router.get('/', auth, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let where = [], params = [], idx = 1;

    if (req.user.role === 'sa_initiator') {
      where.push(`r.initiator_id = $${idx++}`);
      params.push(req.user.id);
    } else if (req.user.role === 'sa_approver') {
      where.push(`r.approver_id = $${idx++}`);
      params.push(req.user.id);
    } else if (req.user.role === 'branch_manager') {
      where.push(`r.branch = $${idx++}`);
      params.push(req.user.branch);
    }
    // ict_manager and super_admin see all

    if (status) { where.push(`r.status = $${idx++}`); params.push(status); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countResult = await pool.query(`SELECT COUNT(*) FROM sa_requests r ${whereClause}`, params);
    const result = await pool.query(`
      SELECT r.*,
        i.full_name AS initiator_name, i.email AS initiator_email,
        a.full_name AS approver_name, a.email AS approver_email
      FROM sa_requests r
      LEFT JOIN users i ON r.initiator_id = i.id
      LEFT JOIN users a ON r.approver_id = a.id
      ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, limit, offset]);

    res.json({
      requests: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      pages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// GET /api/sa/stats
router.get('/stats', auth, async (req, res) => {
  try {
    let filter = '', params = [];
    if (req.user.role === 'sa_initiator') { filter = 'WHERE initiator_id = $1'; params = [req.user.id]; }
    else if (req.user.role === 'sa_approver') { filter = 'WHERE approver_id = $1'; params = [req.user.id]; }
    else if (req.user.role === 'branch_manager') { filter = 'WHERE branch = $1'; params = [req.user.branch]; }

    const [total, pending, approved, declined, under_review] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM sa_requests ${filter}`, params),
      pool.query(`SELECT COUNT(*) FROM sa_requests ${filter ? filter + " AND status='pending'" : "WHERE status='pending'"}`, params),
      pool.query(`SELECT COUNT(*) FROM sa_requests ${filter ? filter + " AND status='approved'" : "WHERE status='approved'"}`, params),
      pool.query(`SELECT COUNT(*) FROM sa_requests ${filter ? filter + " AND status='declined'" : "WHERE status='declined'"}`, params),
      pool.query(`SELECT COUNT(*) FROM sa_requests ${filter ? filter + " AND status='under_review'" : "WHERE status='under_review'"}`, params),
    ]);

    res.json({
      total: parseInt(total.rows[0].count),
      pending: parseInt(pending.rows[0].count),
      approved: parseInt(approved.rows[0].count),
      declined: parseInt(declined.rows[0].count),
      under_review: parseInt(under_review.rows[0].count),
    });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// GET /api/sa/report — full SA requests list for CSV/report (role-filtered)
// IMPORTANT: must be defined before /:id to prevent Express matching 'report' as an ID
router.get('/report', auth, requireRole('sa_initiator', 'sa_approver', 'ict_manager', 'super_admin', 'branch_manager'), async (req, res) => {
  try {
    let where = [], params = [], idx = 1;

    if (req.user.role === 'sa_initiator') {
      where.push(`r.initiator_id = $${idx++}`);
      params.push(req.user.id);
    } else if (req.user.role === 'sa_approver') {
      where.push(`r.approver_id = $${idx++}`);
      params.push(req.user.id);
    } else if (req.user.role === 'branch_manager') {
      where.push(`r.branch = $${idx++}`);
      params.push(req.user.branch);
    }
    // ict_manager and super_admin see all

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const result = await pool.query(`
      SELECT r.*,
        i.full_name AS initiator_name, i.email AS initiator_email,
        a.full_name AS approver_name, a.email AS approver_email
      FROM sa_requests r
      LEFT JOIN users i ON r.initiator_id = i.id
      LEFT JOIN users a ON r.approver_id = a.id
      ${whereClause}
      ORDER BY r.created_at DESC
    `, params);

    res.json({ requests: result.rows });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// POST /api/sa - create new request
router.post('/', auth, requireRole('sa_initiator'), upload.array('attachments', 5), async (req, res) => {
  const { account_number, account_name, previous_salary_month, previous_salary_amount, amount_requested, notes, resubmitted_from } = req.body;

  if (!account_number || !account_name || !previous_salary_month || !previous_salary_amount || !amount_requested) {
    return res.status(400).json({ message: 'All required fields must be filled' });
  }

  // Get initiator's assigned approver
  const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const initiator = userResult.rows[0];
  if (!initiator.assigned_approver_id) {
    return res.status(400).json({ message: 'No approver assigned to your account. Contact Super Admin.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const requestNumber = await generateSANumber();

    const result = await client.query(`
      INSERT INTO sa_requests (
        request_number, account_number, account_name, previous_salary_month,
        previous_salary_amount, amount_requested, branch, initiator_id,
        approver_id, notes, resubmitted_from, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending') RETURNING *
    `, [requestNumber, account_number, account_name, previous_salary_month,
        parseFloat(previous_salary_amount), parseFloat(amount_requested),
        initiator.branch, req.user.id, initiator.assigned_approver_id,
        notes || null, resubmitted_from || null]);

    const request = result.rows[0];

    // Save attachments
    if (req.files?.length) {
      for (const file of req.files) {
        const storedName = file.path || file.secure_url || file.url || file.filename || file.originalname;
        await client.query(
          'INSERT INTO sa_attachments (request_id, original_name, stored_name, mime_type, file_size, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
          [request.id, file.originalname, storedName, file.mimetype, file.size, req.user.id]
        );
      }
    }

    await client.query(
      'INSERT INTO sa_audit_logs (request_id, user_id, action) VALUES ($1,$2,$3)',
      [request.id, req.user.id, resubmitted_from ? 'Request resubmitted' : 'Request created']
    );

    await client.query('COMMIT');

    // Notify approver
    const approverResult = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [initiator.assigned_approver_id]);
    const approver = approverResult.rows[0];
    if (approver) {
      sendEmail(approver.email, {
        subject: `📋 New SA Request — ${requestNumber} from ${initiator.branch}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#0E5F94;padding:20px;text-align:center">
              <h1 style="color:#fff;margin:0;font-size:20px">New Salary Advance Request</h1>
            </div>
            <div style="padding:24px;background:#f7fafd">
              <p>Hi ${approver.full_name},</p>
              <p>A new Salary Advance/Overdraft request has been submitted and requires your review.</p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0">
                <tr><td style="padding:8px;background:#EBF5FF;font-weight:bold;width:160px">Request Number</td><td style="padding:8px;border:1px solid #DAE8F5;font-weight:bold;color:#0E5F94">${requestNumber}</td></tr>
                <tr><td style="padding:8px;background:#EBF5FF;font-weight:bold">Account Name</td><td style="padding:8px;border:1px solid #DAE8F5">${account_name}</td></tr>
                <tr><td style="padding:8px;background:#EBF5FF;font-weight:bold">Account Number</td><td style="padding:8px;border:1px solid #DAE8F5">${account_number}</td></tr>
                <tr><td style="padding:8px;background:#EBF5FF;font-weight:bold">Branch</td><td style="padding:8px;border:1px solid #DAE8F5">${initiator.branch}</td></tr>
                <tr><td style="padding:8px;background:#EBF5FF;font-weight:bold">Amount Requested</td><td style="padding:8px;border:1px solid #DAE8F5;font-weight:bold">${formatCurrency(amount_requested)}</td></tr>
                <tr><td style="padding:8px;background:#EBF5FF;font-weight:bold">Previous Salary</td><td style="padding:8px;border:1px solid #DAE8F5">${previous_salary_month} — ${formatCurrency(previous_salary_amount)}</td></tr>
                ${notes ? `<tr><td style="padding:8px;background:#EBF5FF;font-weight:bold">Notes</td><td style="padding:8px;border:1px solid #DAE8F5">${notes}</td></tr>` : ''}
              </table>
              <a href="${process.env.FRONTEND_URL}/sa/${request.id}" style="display:inline-block;background:#0E5F94;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold">Review Request</a>
            </div>
            <div style="padding:14px;text-align:center;color:#7A9AB8;font-size:12px;background:#e8f4fc">
              OMIYE MFB Internal HelpDesk — Salary Advance System
            </div>
          </div>`
      });
    }

    res.status(201).json({ message: 'Request submitted successfully', request });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally { client.release(); }
});

// GET /api/sa/:id - get single request
router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*,
        i.full_name AS initiator_name, i.email AS initiator_email, i.branch AS initiator_branch,
        a.full_name AS approver_name, a.email AS approver_email
      FROM sa_requests r
      LEFT JOIN users i ON r.initiator_id = i.id
      LEFT JOIN users a ON r.approver_id = a.id
      WHERE r.id = $1
    `, [req.params.id]);

    if (!result.rows.length) return res.status(404).json({ message: 'Request not found' });
    const request = result.rows[0];

    // Access check
    if (req.user.role === 'sa_initiator' && request.initiator_id !== req.user.id) return res.status(403).json({ message: 'Access denied' });
    if (req.user.role === 'sa_approver' && request.approver_id !== req.user.id) return res.status(403).json({ message: 'Access denied' });
    if (req.user.role === 'branch_manager' && request.branch !== req.user.branch) return res.status(403).json({ message: 'Access denied' });

    const [attachments, audit] = await Promise.all([
      pool.query('SELECT a.*, u.full_name AS uploaded_by_name FROM sa_attachments a LEFT JOIN users u ON a.uploaded_by = u.id WHERE a.request_id = $1 ORDER BY a.created_at', [req.params.id]),
      pool.query('SELECT al.*, u.full_name AS user_name FROM sa_audit_logs al LEFT JOIN users u ON al.user_id = u.id WHERE al.request_id = $1 ORDER BY al.created_at', [req.params.id]),
    ]);

    res.json({ ...request, attachments: attachments.rows, audit: audit.rows });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Server error' }); }
});

// PUT /api/sa/:id - approve or decline
router.put('/:id', auth, requireRole('sa_approver', 'ict_manager', 'super_admin'), async (req, res) => {
  const { action, amount_approved, approver_notes, status } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query('SELECT * FROM sa_requests WHERE id = $1', [req.params.id]);
    if (!prev.rows.length) return res.status(404).json({ message: 'Request not found' });
    const request = prev.rows[0];

    if (req.user.role === 'sa_approver' && request.approver_id !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    let newStatus = status;
    if (action === 'approve') newStatus = 'approved';
    if (action === 'decline') newStatus = 'declined';
    if (action === 'review') newStatus = 'under_review';

    const updates = ['status = $1', 'updated_at = NOW()', 'decided_at = NOW()'];
    const params = [newStatus];
    let idx = 2;

    if (approver_notes) { updates.push(`approver_notes = $${idx++}`); params.push(approver_notes); }
    if (action === 'approve' && amount_approved) { updates.push(`amount_approved = $${idx++}`); params.push(parseFloat(amount_approved)); }

    params.push(req.params.id);
    await client.query(`UPDATE sa_requests SET ${updates.join(', ')} WHERE id = $${idx}`, params);

    await client.query(
      'INSERT INTO sa_audit_logs (request_id, user_id, action, old_value, new_value) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, req.user.id, `Status changed to ${newStatus}`, request.status, newStatus]
    );

    await client.query('COMMIT');

    // Notify initiator
    const initiatorResult = await pool.query('SELECT full_name, email FROM users WHERE id = $1', [request.initiator_id]);
    const initiator = initiatorResult.rows[0];
    const approverResult = await pool.query('SELECT full_name FROM users WHERE id = $1', [req.user.id]);
    const approver = approverResult.rows[0];

    if (initiator && (action === 'approve' || action === 'decline')) {
      const isApproved = action === 'approve';
      sendEmail(initiator.email, {
        subject: `${isApproved ? '✅ Approved' : '❌ Declined'} — SA Request ${request.request_number}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
            <div style="background:${isApproved ? '#0FA86A' : '#D63A3A'};padding:20px;text-align:center">
              <h1 style="color:#fff;margin:0;font-size:20px">${isApproved ? '✅ Request Approved' : '❌ Request Declined'}</h1>
            </div>
            <div style="padding:24px;background:#f7fafd">
              <p>Hi ${initiator.full_name},</p>
              <p>Your Salary Advance/Overdraft request <strong>${request.request_number}</strong> has been <strong>${isApproved ? 'APPROVED' : 'DECLINED'}</strong> by ${approver.full_name}.</p>
              ${isApproved && amount_approved ? `<p style="font-size:18px;font-weight:bold;color:#0FA86A">Amount Approved: ${formatCurrency(amount_approved)}</p>` : ''}
              ${approver_notes ? `<p><strong>Notes from Approver:</strong> ${approver_notes}</p>` : ''}
              ${!isApproved ? `<p>You may resubmit your request if you wish to appeal.</p>` : ''}
              <a href="${process.env.FRONTEND_URL}/sa/${request.id}" style="display:inline-block;background:#0E5F94;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold">View Request</a>
            </div>
            <div style="padding:14px;text-align:center;color:#7A9AB8;font-size:12px;background:#e8f4fc">
              OMIYE MFB Internal HelpDesk — Salary Advance System
            </div>
          </div>`
      });
    }

    res.json({ message: `Request ${newStatus} successfully` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  } finally { client.release(); }
});

module.exports = router;
