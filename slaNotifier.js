const pool = require('./db');
const { sendEmail, emailTemplates } = require('./emailService');

async function checkSLABreaches() {
  console.log('⏰ Checking SLA breaches...');
  try {
    // Find all tickets that have breached SLA and are not resolved/closed
    // and haven't had a breach notification sent in the last 6 hours
    const result = await pool.query(`
      SELECT t.*,
        c.full_name AS created_by_name, c.email AS created_by_email,
        a.full_name AS assigned_to_name, a.email AS assigned_to_email,
        u.email AS manager_email
      FROM tickets t
      LEFT JOIN users c ON t.created_by = c.id
      LEFT JOIN users a ON t.assigned_to = a.id
      LEFT JOIN users u ON u.role = 'ict_manager' AND u.is_active = true
      WHERE t.sla_deadline < NOW()
        AND t.status NOT IN ('resolved', 'closed')
        AND (t.last_sla_notification IS NULL OR t.last_sla_notification < NOW() - INTERVAL '6 hours')
    `);

    for (const ticket of result.rows) {
      const hoursOverdue = Math.round((new Date() - new Date(ticket.sla_deadline)) / 3600000);

      // Notify assigned staff
      if (ticket.assigned_to_email) {
        sendEmail(ticket.assigned_to_email, {
          subject: `⚠️ SLA BREACH ALERT — ${ticket.ticket_number}: ${ticket.subject}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
              <div style="background:#D63A3A;padding:20px;text-align:center">
                <h1 style="color:#fff;margin:0;font-size:20px">⚠️ SLA BREACH ALERT</h1>
              </div>
              <div style="padding:24px;background:#f7fafd">
                <h2 style="color:#D63A3A">Ticket SLA Has Been Breached!</h2>
                <p>Hi ${ticket.assigned_to_name || 'Team'},</p>
                <p>The following ticket has exceeded its SLA deadline and requires <strong>immediate attention</strong>.</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0">
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold;width:140px">Ticket Number</td><td style="padding:8px;border:1px solid #f5c6c6;font-weight:bold;color:#D63A3A">${ticket.ticket_number}</td></tr>
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold">Subject</td><td style="padding:8px;border:1px solid #f5c6c6">${ticket.subject}</td></tr>
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold">Branch</td><td style="padding:8px;border:1px solid #f5c6c6">${ticket.branch}</td></tr>
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold">Priority</td><td style="padding:8px;border:1px solid #f5c6c6;text-transform:capitalize;font-weight:bold">${ticket.priority}</td></tr>
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold">SLA Deadline</td><td style="padding:8px;border:1px solid #f5c6c6;color:#D63A3A;font-weight:bold">${new Date(ticket.sla_deadline).toLocaleString('en-NG')}</td></tr>
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold">Hours Overdue</td><td style="padding:8px;border:1px solid #f5c6c6;color:#D63A3A;font-weight:bold">${hoursOverdue} hour(s)</td></tr>
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold">Raised By</td><td style="padding:8px;border:1px solid #f5c6c6">${ticket.created_by_name} — ${ticket.branch}</td></tr>
                </table>
                <div style="background:#FEF1E8;border-left:4px solid #D63A3A;padding:12px;border-radius:4px;margin:16px 0">
                  <strong>⚠️ Action Required:</strong> Please resolve or escalate this ticket immediately.
                </div>
                <a href="${process.env.FRONTEND_URL}/tickets/${ticket.id}" style="display:inline-block;background:#D63A3A;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold">
                  View & Resolve Ticket Now
                </a>
              </div>
              <div style="padding:14px;text-align:center;color:#6B8CAE;font-size:12px;background:#e8f4fc">
                OMIYE MFB Internal HelpDesk System — Automated SLA Alert
              </div>
            </div>`,
        });
      }

      // Notify ICT Manager
      if (ticket.manager_email) {
        sendEmail(ticket.manager_email, {
          subject: `🚨 Manager Alert — SLA Breach on ${ticket.ticket_number}: ${ticket.subject}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
              <div style="background:#D63A3A;padding:20px;text-align:center">
                <h1 style="color:#fff;margin:0;font-size:20px">🚨 Manager SLA Breach Alert</h1>
              </div>
              <div style="padding:24px;background:#f7fafd">
                <h2 style="color:#D63A3A">Ticket Requires Your Attention</h2>
                <p>Hi Manager,</p>
                <p>A ticket under your team has breached its SLA deadline. Please review and take action.</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0">
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold;width:140px">Ticket Number</td><td style="padding:8px;border:1px solid #f5c6c6;font-weight:bold;color:#D63A3A">${ticket.ticket_number}</td></tr>
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold">Subject</td><td style="padding:8px;border:1px solid #f5c6c6">${ticket.subject}</td></tr>
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold">Assigned To</td><td style="padding:8px;border:1px solid #f5c6c6">${ticket.assigned_to_name || 'Unassigned'}</td></tr>
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold">Branch</td><td style="padding:8px;border:1px solid #f5c6c6">${ticket.branch}</td></tr>
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold">Priority</td><td style="padding:8px;border:1px solid #f5c6c6;text-transform:capitalize">${ticket.priority}</td></tr>
                  <tr><td style="padding:8px;background:#fdeaea;font-weight:bold">Hours Overdue</td><td style="padding:8px;border:1px solid #f5c6c6;color:#D63A3A;font-weight:bold">${hoursOverdue} hour(s)</td></tr>
                </table>
                <a href="${process.env.FRONTEND_URL}/tickets/${ticket.id}" style="display:inline-block;background:#D63A3A;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold">
                  View Ticket
                </a>
              </div>
              <div style="padding:14px;text-align:center;color:#6B8CAE;font-size:12px;background:#e8f4fc">
                OMIYE MFB Internal HelpDesk System — Automated Manager Alert
              </div>
            </div>`,
        });
      }

      // Update last notification time
      await pool.query('UPDATE tickets SET last_sla_notification = NOW() WHERE id = $1', [ticket.id]);
      console.log(`📧 SLA breach notification sent for ${ticket.ticket_number}`);
    }

    if (result.rows.length === 0) console.log('✅ No SLA breaches found');
  } catch (err) {
    console.error('SLA check error:', err.message);
  }
}

// Run every hour
function startSLANotifier() {
  console.log('🔔 SLA Notifier started — checking every hour');
  checkSLABreaches(); // Run immediately on startup
  setInterval(checkSLABreaches, 60 * 60 * 1000); // Then every hour
}

module.exports = { startSLANotifier };
