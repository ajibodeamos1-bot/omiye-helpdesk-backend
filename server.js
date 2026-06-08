const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // Required on Render — reads real client IP from X-Forwarded-For

app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/tickets/:ticketId/comments', require('./routes/comments'));
app.use('/api/users', require('./routes/users'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/sa', require('./routes/sa'));

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  const { startSLANotifier } = require('./slaNotifier');
  startSLANotifier();
});
