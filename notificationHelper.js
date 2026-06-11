const pool = require('./db');

/**
 * Create a notification for one or more users
 * @param {Array} userIds - array of user IDs to notify
 * @param {string} message - notification text
 * @param {string} type - 'ticket_update' | 'ticket_assigned' | 'ticket_comment' | 'sa_update'
 * @param {string|null} ticketId - optional ticket UUID
 * @param {string|null} saRequestId - optional SA request UUID
 */
async function createNotifications(userIds, message, type, ticketId = null, saRequestId = null) {
  if (!userIds || userIds.length === 0) return;
  try {
    const unique = [...new Set(userIds.filter(Boolean))];
    const values = unique.map((uid, i) => {
      const base = i * 5;
      return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, $${base+5})`;
    }).join(', ');
    const params = unique.flatMap(uid => [uid, message, type, ticketId, saRequestId]);
    await pool.query(
      `INSERT INTO notifications (user_id, message, type, ticket_id, sa_request_id) VALUES ${values}`,
      params
    );
  } catch (err) {
    console.error('Notification error:', err.message);
  }
}

module.exports = { createNotifications };
