const https = require('https');

async function sendEmail(to, template) {
  try {
    const payload = JSON.stringify({
      from: process.env.EMAIL_FROM || 'OMIYE MFB HelpDesk <onboarding@resend.dev>',
      to: [to],
      subject: template.subject,
      html: template.html,
    });

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`📧 Email sent to ${to}`);
            resolve(data);
          } else {
            console.error(`❌ Email failed to ${to}: ${data}`);
            reject(new Error(data));
          }
        });
      });
      req.on('error', (err) => {
        console.error(`❌ Email error to ${to}:`, err.message);
        reject(err);
      });
      req.write(payload);
      req.end();
    });
  } catch (err) {
    console.error(`❌ Email failed to ${to}:`, err.message);
    // Don't throw — email failure shouldn't crash the app
  }
}

const emailTemplates = {
  ticketCreated: (ticket, creator, department) => {
    const team = department === 'finance' ? 'Finance Team' : 'ICT Team';
    const teamColor = department === 'finance' ? '#0FA86A' : '#0E5F94';
    return {
    subject: `[OMIYE MFB HelpDesk] New Ticket ${ticket.ticket_number}: ${ticket.subject}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:${teamColor};padding:20px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:20px">OMIYE MFB HelpDesk</h1>
        </div>
        <div style="padding:24px;background:#f7fafd">
          <h2 style="color:#1A2940">New Ticket Submitted</h2>
          <p>Hi ${team},</p>
          <p>A new support ticket has been lodged and requires your attention.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold;width:140px">Ticket Number</td><td style="padding:8px;border:1px solid #d4e8f5">${ticket.ticket_number}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Subject</td><td style="padding:8px;border:1px solid #d4e8f5">${ticket.subject}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Department</td><td style="padding:8px;border:1px solid #d4e8f5;font-weight:bold;color:${teamColor}">${team}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Category</td><td style="padding:8px;border:1px solid #d4e8f5">${ticket.category}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Priority</td><td style="padding:8px;border:1px solid #d4e8f5;color:${ticket.priority==='critical'?'#D04040':ticket.priority==='high'?'#E8A020':'#1A2940'};font-weight:bold;text-transform:capitalize">${ticket.priority}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Branch</td><td style="padding:8px;border:1px solid #d4e8f5">${ticket.branch}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Submitted By</td><td style="padding:8px;border:1px solid #d4e8f5">${creator.full_name}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Date & Time</td><td style="padding:8px;border:1px solid #d4e8f5">${new Date(ticket.created_at).toLocaleString('en-NG')}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">SLA Deadline</td><td style="padding:8px;border:1px solid #d4e8f5;color:#D04040;font-weight:bold">${ticket.sla_deadline ? new Date(ticket.sla_deadline).toLocaleString('en-NG') : 'No SLA'}</td></tr>
          </table>
          <div style="background:#fff;padding:12px;border-left:4px solid ${teamColor};margin:16px 0">
            <strong>Description:</strong><br/>${ticket.description}
          </div>
          <a href="${process.env.FRONTEND_URL}/tickets/${ticket.id}" style="display:inline-block;background:#F4873A;color:#fff;padding:10px 22px;text-decoration:none;border-radius:6px;font-weight:bold">View & Respond to Ticket</a>
        </div>
        <div style="padding:14px;text-align:center;color:#6B8CAE;font-size:12px;background:#e8f4fc">
          OMIYE MFB Internal HelpDesk System — Do not reply to this email
        </div>
      </div>`,
    };
  },

  ticketConfirmation: (ticket, creator, department) => {
    const team = department === 'finance' ? 'Finance Team' : 'ICT team';
    return {
    subject: `[OMIYE MFB HelpDesk] Your Ticket ${ticket.ticket_number} Has Been Received`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#0E5F94;padding:20px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:20px">OMIYE MFB HelpDesk</h1>
        </div>
        <div style="padding:24px;background:#f7fafd">
          <h2 style="color:#1A2940">Ticket Received ✅</h2>
          <p>Hi ${creator.full_name},</p>
          <p>Your support ticket has been successfully submitted. The ${team} will attend to it based on priority.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold;width:140px">Ticket Number</td><td style="padding:8px;border:1px solid #d4e8f5;font-weight:bold;color:#0E5F94">${ticket.ticket_number}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Subject</td><td style="padding:8px;border:1px solid #d4e8f5">${ticket.subject}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Priority</td><td style="padding:8px;border:1px solid #d4e8f5;text-transform:capitalize">${ticket.priority}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Status</td><td style="padding:8px;border:1px solid #d4e8f5">Pending</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">SLA Deadline</td><td style="padding:8px;border:1px solid #d4e8f5">${ticket.sla_deadline ? new Date(ticket.sla_deadline).toLocaleString('en-NG') : 'No SLA'}</td></tr>
          </table>
          <p>You will receive an email update whenever the ${team} responds or changes the status of your ticket.</p>
          <a href="${process.env.FRONTEND_URL}/tickets/${ticket.id}" style="display:inline-block;background:#1B8FD4;color:#fff;padding:10px 22px;text-decoration:none;border-radius:6px;font-weight:bold">Track Your Ticket</a>
        </div>
        <div style="padding:14px;text-align:center;color:#6B8CAE;font-size:12px;background:#e8f4fc">
          OMIYE MFB Internal HelpDesk System — Do not reply to this email
        </div>
      </div>`,
    };
  },

  ticketUpdated: (ticket, updatedBy, action, comment) => ({
    subject: `[OMIYE MFB HelpDesk] Update on Ticket ${ticket.ticket_number}: ${ticket.subject}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#0E5F94;padding:20px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:20px">OMIYE MFB HelpDesk</h1>
        </div>
        <div style="padding:24px;background:#f7fafd">
          <h2 style="color:#1A2940">Ticket Update</h2>
          <p>There has been an update on your support ticket.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold;width:140px">Ticket Number</td><td style="padding:8px;border:1px solid #d4e8f5;font-weight:bold;color:#0E5F94">${ticket.ticket_number}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Subject</td><td style="padding:8px;border:1px solid #d4e8f5">${ticket.subject}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Action</td><td style="padding:8px;border:1px solid #d4e8f5;font-weight:bold;color:#F4873A">${action}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Current Status</td><td style="padding:8px;border:1px solid #d4e8f5;text-transform:capitalize">${ticket.status.replace('_',' ')}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Updated By</td><td style="padding:8px;border:1px solid #d4e8f5">${updatedBy.full_name}</td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Date & Time</td><td style="padding:8px;border:1px solid #d4e8f5">${new Date().toLocaleString('en-NG')}</td></tr>
          </table>
          ${comment ? `<div style="background:#fff;padding:12px;border-left:4px solid #F4873A;margin:16px 0"><strong>Message from ICT:</strong><br/>${comment}</div>` : ''}
          <a href="${process.env.FRONTEND_URL}/tickets/${ticket.id}" style="display:inline-block;background:#1B8FD4;color:#fff;padding:10px 22px;text-decoration:none;border-radius:6px;font-weight:bold">View Full Ticket</a>
        </div>
        <div style="padding:14px;text-align:center;color:#6B8CAE;font-size:12px;background:#e8f4fc">
          OMIYE MFB Internal HelpDesk System — Do not reply to this email
        </div>
      </div>`,
  }),

  ticketEscalated: (ticket, updater, comment) => ({
    subject: `🚨 ESCALATED — Ticket ${ticket.ticket_number} requires urgent attention`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#D63A3A;padding:20px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:20px">🚨 Ticket Escalated</h1>
        </div>
        <div style="padding:24px;background:#f7fafd">
          <p>Hi,</p>
          <p>A support ticket has been <strong style="color:#D63A3A">ESCALATED</strong> by ${updater.full_name} and requires urgent management attention.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px;background:#FDEAEA;font-weight:bold;width:140px">Ticket Number</td><td style="padding:8px;border:1px solid #F5D4D4;font-weight:bold;color:#D63A3A">${ticket.ticket_number}</td></tr>
            <tr><td style="padding:8px;background:#FDEAEA;font-weight:bold">Subject</td><td style="padding:8px;border:1px solid #F5D4D4">${ticket.subject}</td></tr>
            <tr><td style="padding:8px;background:#FDEAEA;font-weight:bold">Branch</td><td style="padding:8px;border:1px solid #F5D4D4">${ticket.branch}</td></tr>
            <tr><td style="padding:8px;background:#FDEAEA;font-weight:bold">Priority</td><td style="padding:8px;border:1px solid #F5D4D4;text-transform:capitalize">${ticket.priority}</td></tr>
            <tr><td style="padding:8px;background:#FDEAEA;font-weight:bold">Escalated By</td><td style="padding:8px;border:1px solid #F5D4D4">${updater.full_name}</td></tr>
            <tr><td style="padding:8px;background:#FDEAEA;font-weight:bold">SLA Deadline</td><td style="padding:8px;border:1px solid #F5D4D4;color:#D63A3A;font-weight:bold">${ticket.sla_deadline ? new Date(ticket.sla_deadline).toLocaleString('en-NG') : 'No SLA'}</td></tr>
          </table>
          ${comment ? `<div style="background:#fff;padding:12px;border-left:4px solid #D63A3A;margin:16px 0"><strong>Note from ${updater.full_name}:</strong><br/>${comment}</div>` : ''}
          <a href="${process.env.FRONTEND_URL}/tickets/${ticket.id}" style="display:inline-block;background:#D63A3A;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold">View Escalated Ticket</a>
        </div>
        <div style="padding:14px;text-align:center;color:#6B8CAE;font-size:12px;background:#e8f4fc">
          OMIYE MFB Internal HelpDesk System — Do not reply to this email
        </div>
      </div>`,
  }),

  ticketResolved: (ticket, resolvedBy, resolutionNote) => ({
    subject: `[OMIYE MFB HelpDesk] ✅ Ticket ${ticket.ticket_number} Has Been Resolved`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1A9E6B;padding:20px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:20px">OMIYE MFB HelpDesk</h1>
        </div>
        <div style="padding:24px;background:#f7fafd">
          <h2 style="color:#1A9E6B">✅ Your Ticket Has Been Resolved!</h2>
          <p>Great news! Your support ticket has been resolved by the ICT team.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px;background:#e6f7f0;font-weight:bold;width:140px">Ticket Number</td><td style="padding:8px;border:1px solid #c3e8d8;font-weight:bold;color:#0E5F94">${ticket.ticket_number}</td></tr>
            <tr><td style="padding:8px;background:#e6f7f0;font-weight:bold">Subject</td><td style="padding:8px;border:1px solid #c3e8d8">${ticket.subject}</td></tr>
            <tr><td style="padding:8px;background:#e6f7f0;font-weight:bold">Resolved By</td><td style="padding:8px;border:1px solid #c3e8d8">${resolvedBy.full_name}</td></tr>
            <tr><td style="padding:8px;background:#e6f7f0;font-weight:bold">Resolved At</td><td style="padding:8px;border:1px solid #c3e8d8">${new Date().toLocaleString('en-NG')}</td></tr>
          </table>
          ${resolutionNote ? `<div style="background:#fff;padding:12px;border-left:4px solid #1A9E6B;margin:16px 0"><strong>Resolution Notes:</strong><br/>${resolutionNote}</div>` : ''}
          <p>If you are satisfied with the resolution, no action is needed — the ticket will close automatically after 24 hours.</p>
          <p>If the issue persists, please <a href="${process.env.FRONTEND_URL}/tickets/${ticket.id}" style="color:#0E5F94">click here to reopen the ticket</a>.</p>
        </div>
        <div style="padding:14px;text-align:center;color:#6B8CAE;font-size:12px;background:#e6f7f0">
          OMIYE MFB Internal HelpDesk System — Do not reply to this email
        </div>
      </div>`,
  }),

  passwordReset: (user, token) => ({
    subject: `[OMIYE MFB HelpDesk] Password Reset Request`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#0E5F94;padding:20px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:20px">OMIYE MFB HelpDesk</h1>
        </div>
        <div style="padding:24px;background:#f7fafd">
          <h2 style="color:#1A2940">🔑 Password Reset Request</h2>
          <p>Hi ${user.full_name},</p>
          <p>We received a request to reset your password. Click the button below to set a new password.</p>
          <div style="text-align:center;margin:24px 0">
            <a href="${process.env.FRONTEND_URL}/reset-password?token=${token}" 
               style="display:inline-block;background:#F4873A;color:#fff;padding:14px 28px;text-decoration:none;border-radius:7px;font-weight:bold;font-size:15px">
              🔐 Reset My Password
            </a>
          </div>
          <div style="background:#FEF1E8;border-left:4px solid #F4873A;padding:12px;border-radius:4px;margin:16px 0">
            <strong>⚠️ This link expires in 1 hour.</strong> If you did not request a password reset, please ignore this email.
          </div>
          <p style="font-size:12px;color:#6B8CAE">For security, this link can only be used once.</p>
        </div>
        <div style="padding:14px;text-align:center;color:#6B8CAE;font-size:12px;background:#e8f4fc">
          OMIYE MFB Internal HelpDesk System — Do not reply to this email
        </div>
      </div>`,
  }),

  passwordResetByAdmin: (user, password, expiresAt) => ({
    subject: `[OMIYE MFB HelpDesk] 🔑 Your Password Has Been Reset`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#0E5F94;padding:20px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:20px">OMIYE MFB HelpDesk</h1>
        </div>
        <div style="padding:24px;background:#f7fafd">
          <h2 style="color:#1A2940">🔑 Password Reset by Administrator</h2>
          <p>Hi ${user.full_name},</p>
          <p>Your password on the OMIYE MFB HelpDesk has been reset by a System Administrator. Use the temporary credentials below to log in.</p>
          <div style="background:#fff;border:2px solid #F4873A;border-radius:8px;padding:20px;margin:20px 0;text-align:center">
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Your Temporary Password</div>
            <div style="font-size:24px;font-weight:800;color:#F4873A;letter-spacing:3px;font-family:monospace">${password}</div>
          </div>
          <div style="background:#FEF1E8;border-left:4px solid #F4873A;padding:12px;border-radius:4px;margin:16px 0">
            <strong>⏰ This password expires at: ${expiresAt}</strong><br/>
            You must log in and change your password before it expires.
          </div>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold;width:140px">Website</td>
                <td style="padding:8px;border:1px solid #d4e8f5"><a href="${process.env.FRONTEND_URL}" style="color:#0E5F94">${process.env.FRONTEND_URL}</a></td></tr>
            <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Email</td>
                <td style="padding:8px;border:1px solid #d4e8f5">${user.email}</td></tr>
          </table>
          <a href="${process.env.FRONTEND_URL}" style="display:inline-block;background:#1B8FD4;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold">
            🔐 Login Now
          </a>
          <p style="margin-top:20px;font-size:12px;color:#6B8CAE">
            If you did not expect this reset, please contact your System Administrator immediately.
          </p>
        </div>
        <div style="padding:14px;text-align:center;color:#6B8CAE;font-size:12px;background:#e8f4fc">
          OMIYE MFB Internal HelpDesk System — Do not reply to this email
        </div>
      </div>`,
  }),

  welcomeUser: (user, password, expiresAt) => ({
    subject: `Welcome to OMIYE MFB HelpDesk — Your Login Details`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#0E5F94;padding:20px;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:20px">OMIYE MFB HelpDesk</h1>
        </div>
        <div style="padding:24px;background:#f7fafd">
          <h2 style="color:#1A2940">Welcome, ${user.full_name}! 👋</h2>
          <p>Your account has been created on the OMIYE MFB Internal HelpDesk System. Use the credentials below to log in.</p>
          <div style="background:#fff;border:2px solid #F4873A;border-radius:8px;padding:20px;margin:20px 0;text-align:center">
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Your Temporary Password</div>
            <div style="font-size:24px;font-weight:800;color:#F4873A;letter-spacing:3px;font-family:monospace">${password}</div>
          </div>
          <div style="background:#fff;border:1px solid #D4E8F5;border-radius:8px;padding:20px;margin:20px 0">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold;width:140px">Website</td>
                  <td style="padding:8px;border:1px solid #d4e8f5"><a href="${process.env.FRONTEND_URL}" style="color:#0E5F94">${process.env.FRONTEND_URL}</a></td></tr>
              <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Email</td>
                  <td style="padding:8px;border:1px solid #d4e8f5">${user.email}</td></tr>
              <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Your Role</td>
                  <td style="padding:8px;border:1px solid #d4e8f5;text-transform:capitalize">${user.role.replace(/_/g,' ')}</td></tr>
              <tr><td style="padding:8px;background:#e8f4fc;font-weight:bold">Branch</td>
                  <td style="padding:8px;border:1px solid #d4e8f5">${user.branch}</td></tr>
            </table>
          </div>
          <div style="background:#FEF1E8;border-left:4px solid #F4873A;padding:12px;border-radius:4px;margin:16px 0">
            <strong>⏰ This password expires at: ${expiresAt}</strong><br/>
            You must log in and change your password before it expires. Contact your System Administrator if it expires before you log in.
          </div>
          <a href="${process.env.FRONTEND_URL}" style="display:inline-block;background:#1B8FD4;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;margin-top:8px">
            🔐 Login to HelpDesk
          </a>
          <p style="margin-top:20px;font-size:12px;color:#6B8CAE">
            If you have any issues logging in, please contact your System Administrator.
          </p>
        </div>
        <div style="padding:14px;text-align:center;color:#6B8CAE;font-size:12px;background:#e8f4fc">
          OMIYE MFB Internal HelpDesk System — Do not reply to this email
        </div>
      </div>`,
  }),
};

module.exports = { sendEmail, emailTemplates };
