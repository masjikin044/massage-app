'use strict';
/**
 * features.js — fitur tambahan (TIDAK mengubah logika server.js yang sudah ada).
 * Di-mount dari server.js lewat 1 baris require sebelum route bawaan didaftarkan,
 * sehingga route di sini (GET /api/users, GET|POST /api/messages, POST /api/admin/broadcast)
 * mengambil alih route bawaan yang namanya sama.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, 'data', 'backups'));
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '50', 10);
const MAX_FILES = 20;
const JWT_SECRET = () => process.env.JWT_SECRET || 'secret';

// Ekstensi yang boleh ditampilkan inline (gambar/video/audio). Sisanya selalu di-download.
const INLINE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.mp3', '.ogg', '.oga', '.opus', '.wav', '.m4a']);
// Ekstensi yang ditolak saat upload (bisa dieksekusi / bisa memuat script di browser).
const BLOCKED_EXT = new Set(['.exe', '.bat', '.cmd', '.sh', '.js', '.msi', '.com', '.scr', '.ps1', '.jar', '.php', '.html', '.htm', '.svg']);

module.exports = function mountFeatures(ctx) {
  const { app, io, pool, authenticateToken, requireAdmin, logAudit, totalMessagesCounter } = ctx;

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  /* ------------------------------------------------------------------ */
  /* Email (SMTP asli)                                                   */
  /* ------------------------------------------------------------------ */
  let transporter = null;
  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
    console.log('[mail] SMTP aktif ->', process.env.SMTP_HOST);
  } else {
    console.log('[mail] SMTP_HOST kosong: notifikasi email dinonaktifkan.');
  }

  async function sendMail(to, subject, text) {
    if (!transporter || !to) return;
    try {
      await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
    } catch (e) {
      console.error('[mail] gagal kirim ke', to, e.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Presence & socket auth (agar pesan dikirim privat, bukan io.emit)   */
  /* ------------------------------------------------------------------ */
  const online = new Map(); // userId -> Set<socketId>
  io.on('connection', (socket) => {
    socket.on('auth', (token) => {
      jwt.verify(String(token || ''), JWT_SECRET(), async (err, u) => {
        if (err) return;
        try {
          const r = await pool.query('SELECT id, status FROM users WHERE id = $1', [u.id]);
          if (!r.rowCount || r.rows[0].status !== 'active') return;
          socket.data.userId = u.id;
          socket.join('user_' + u.id);
          socket.join('authed');
          if (!online.has(u.id)) online.set(u.id, new Set());
          online.get(u.id).add(socket.id);
        } catch (e) { console.error('[socket auth]', e.message); }
      });
    });
    socket.on('disconnect', () => {
      const id = socket.data.userId;
      if (id && online.has(id)) {
        online.get(id).delete(socket.id);
        if (!online.get(id).size) online.delete(id);
      }
    });
  });
  const toUser = (userId, event, payload) => io.to('user_' + userId).emit(event, payload);

  // Email pesan masuk: hanya jika penerima OFFLINE, dan maksimal 1 email / 10 menit per pasangan pengirim-penerima.
  const mailThrottle = new Map();
  async function notifyMessageEmail(receiverId, senderName, preview) {
    if (!transporter || online.has(receiverId)) return;
    const key = senderName + ':' + receiverId;
    const last = mailThrottle.get(key) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return;
    mailThrottle.set(key, Date.now());
    try {
      const r = await pool.query("SELECT COALESCE(notify_email, email) AS email, email_notifications FROM users WHERE id = $1 AND status = 'active'", [receiverId]);
      if (!r.rowCount || r.rows[0].email_notifications === false) return;
      await sendMail(r.rows[0].email, `Pesan baru dari ${senderName}`, `${senderName} mengirim pesan:\n\n${preview}\n\nBuka aplikasi untuk membalas.`);
    } catch (e) { console.error('[mail] notif pesan', e.message); }
  }

  /* ------------------------------------------------------------------ */
  /* Skema database (aditif; tabel lama tidak diubah kecuali ADD COLUMN) */
  /* ------------------------------------------------------------------ */
  async function initFeatureTables() {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications BOOLEAN DEFAULT TRUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_email VARCHAR(255);
      CREATE TABLE IF NOT EXISTS email_verifications (
        user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        new_email VARCHAR(255) NOT NULL,
        code_hash VARCHAR(64) NOT NULL,
        attempts INT DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uidx ON users(phone) WHERE phone IS NOT NULL;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind VARCHAR(20) DEFAULT 'text';

      CREATE TABLE IF NOT EXISTS contacts (
        owner_id INT REFERENCES users(id) ON DELETE CASCADE,
        contact_id INT REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_id, contact_id)
      );

      CREATE TABLE IF NOT EXISTS chat_groups (
        id SERIAL PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        invite_code VARCHAR(16) UNIQUE NOT NULL,
        created_by INT REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS chat_group_members (
        group_id INT REFERENCES chat_groups(id) ON DELETE CASCADE,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(10) DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS chat_group_messages (
        id SERIAL PRIMARY KEY,
        group_id INT REFERENCES chat_groups(id) ON DELETE CASCADE,
        sender_id INT REFERENCES users(id),
        message TEXT NOT NULL DEFAULT '',
        kind VARCHAR(20) DEFAULT 'text',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL,
        deleted_by INT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id SERIAL PRIMARY KEY,
        sender_id INT REFERENCES users(id),
        receiver_id INT REFERENCES users(id),
        group_id INT REFERENCES chat_groups(id) ON DELETE CASCADE,
        message TEXT NOT NULL DEFAULT '',
        kind VARCHAR(20) DEFAULT 'text',
        deliver_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(12) DEFAULT 'pending',
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        sent_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS scheduled_due_idx ON scheduled_messages(status, deliver_at);

      CREATE TABLE IF NOT EXISTS attachments (
        id SERIAL PRIMARY KEY,
        uploader_id INT REFERENCES users(id),
        message_id INT REFERENCES messages(id) ON DELETE SET NULL,
        group_message_id INT REFERENCES chat_group_messages(id) ON DELETE SET NULL,
        scheduled_id INT REFERENCES scheduled_messages(id) ON DELETE SET NULL,
        kind VARCHAR(10) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        stored_name VARCHAR(120) NOT NULL,
        mime VARCHAR(120),
        size BIGINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL
      );
      CREATE INDEX IF NOT EXISTS attachments_msg_idx ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS attachments_gmsg_idx ON attachments(group_message_id);

      CREATE TABLE IF NOT EXISTS admin_warnings (
        id SERIAL PRIMARY KEY,
        admin_id INT REFERENCES users(id),
        target_user_id INT REFERENCES users(id),
        message TEXT NOT NULL,
        expires_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ NULL
      );

      CREATE TABLE IF NOT EXISTS backups (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(120) NOT NULL,
        size BIGINT DEFAULT 0,
        file_count INT DEFAULT 0,
        created_by INT REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // Pemulihan jika server mati saat sedang mengirim pesan terjadwal
    await pool.query("UPDATE scheduled_messages SET status = 'pending' WHERE status = 'sending'");
  }

  // initDb() bawaan berjalan paralel dan membuat tabel users/messages; tunggu sampai siap.
  (async function bootFeatures() {
    for (let i = 0; i < 40; i++) {
      try {
        await initFeatureTables();
        console.log('[features] tabel fitur siap.');
        startScheduler();
        return;
      } catch (e) {
        if (i === 39) return console.error('[features] gagal inisialisasi tabel:', e.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();

  /* ------------------------------------------------------------------ */
  /* Helper umum                                                         */
  /* ------------------------------------------------------------------ */
  // <img src> / <video src> tidak bisa kirim header Authorization -> izinkan ?token=
  function authQ(req, res, next) {
    if (!req.headers.authorization && req.query.token) req.headers.authorization = 'Bearer ' + req.query.token;
    return authenticateToken(req, res, next);
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error('[features]', req.method, req.path, e.message);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  });

  const ATT_SQL = (col) => `COALESCE((SELECT json_agg(json_build_object('id', a.id, 'kind', a.kind, 'name', a.original_name, 'mime', a.mime, 'size', a.size) ORDER BY a.id)
     FROM attachments a WHERE a.${col} = m.id AND a.deleted_at IS NULL), '[]'::json) AS attachments`;

  async function fetchDirect(id) {
    const r = await pool.query(
      `SELECT m.id, m.sender_id, m.receiver_id, m.message, m.kind, m.created_at, m.deleted_at, m.deleted_by,
              u1.username AS sender_name, u2.username AS receiver_name, ${ATT_SQL('message_id')}
       FROM messages m JOIN users u1 ON u1.id = m.sender_id JOIN users u2 ON u2.id = m.receiver_id WHERE m.id = $1`, [id]);
    return r.rows[0];
  }
  async function fetchGroupMsg(id) {
    const r = await pool.query(
      `SELECT m.id, m.group_id, m.sender_id, m.message, m.kind, m.created_at, m.deleted_at, u.username AS sender_name, ${ATT_SQL('group_message_id')}
       FROM chat_group_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1`, [id]);
    return r.rows[0];
  }

  const fixName = (n) => Buffer.from(String(n || 'file'), 'latin1').toString('utf8').replace(/[\\/\0]/g, '_').slice(0, 200);

  function kindOfFile(f) {
    if (f.fieldname === 'voice') return 'voice';
    const m = f.mimetype || '';
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    return 'file';
  }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      let ext = path.extname(fixName(file.originalname)).toLowerCase();
      if (!/^\.[a-z0-9]{1,8}$/.test(ext)) ext = '';
      cb(null, crypto.randomBytes(16).toString('hex') + ext);
    }
  });
  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES + 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(fixName(file.originalname)).toLowerCase();
      if (BLOCKED_EXT.has(ext)) return cb(new Error(`Tipe file tidak diizinkan: ${ext}`));
      cb(null, true);
    }
  }).fields([{ name: 'files', maxCount: MAX_FILES }, { name: 'voice', maxCount: 1 }]);

  function parseUpload(req, res, next) {
    if (!req.is('multipart/form-data')) return next();
    upload(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? `Ukuran file maksimal ${MAX_FILE_MB} MB per file.`
          : err.code === 'LIMIT_UNEXPECTED_FILE' ? `Maksimal ${MAX_FILES} file per pengiriman.` : err.message;
        return res.status(400).json({ error: msg });
      }
      next();
    });
  }
  const uploadedFiles = (req) => [].concat(...Object.values(req.files || {}));
  const discard = (files) => files.forEach((f) => fs.unlink(f.path, () => {}));

  async function saveAttachments(uploaderId, files, scheduledId) {
    const ids = [];
    for (const f of files) {
      const r = await pool.query(
        `INSERT INTO attachments (uploader_id, scheduled_id, kind, original_name, stored_name, mime, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [uploaderId, scheduledId || null, kindOfFile(f), fixName(f.originalname), f.filename, (f.mimetype || '').slice(0, 120), f.size]);
      ids.push(r.rows[0].id);
    }
    return ids;
  }

  async function removeAttachmentFiles(where, params) {
    const r = await pool.query(`SELECT id, stored_name FROM attachments WHERE deleted_at IS NULL AND ${where}`, params);
    for (const a of r.rows) fs.unlink(path.join(UPLOAD_DIR, path.basename(a.stored_name)), () => {});
    if (r.rowCount) await pool.query('UPDATE attachments SET deleted_at = NOW() WHERE id = ANY($1::int[])', [r.rows.map((a) => a.id)]);
    return r.rowCount;
  }

  const ensureMutual = (a, b) => pool.query(
    'INSERT INTO contacts (owner_id, contact_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING', [a, b]);

  async function canMessage(sender, receiverId) {
    const t = await pool.query("SELECT id, role FROM users WHERE id = $1 AND status = 'active'", [receiverId]);
    if (!t.rowCount) return { ok: false, error: 'Penerima tidak ditemukan atau tidak aktif.' };
    if (sender.role === 'admin') return { ok: true };
    const c = await pool.query('SELECT 1 FROM contacts WHERE owner_id = $1 AND contact_id = $2', [sender.id, receiverId]);
    if (!c.rowCount) return { ok: false, error: 'Tambahkan user ini ke Kontak terlebih dahulu sebelum mengirim pesan.' };
    return { ok: true };
  }
  async function isMember(groupId, userId) {
    const r = await pool.query('SELECT 1 FROM chat_group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
    return r.rowCount > 0;
  }
  async function memberIds(groupId) {
    const r = await pool.query('SELECT user_id FROM chat_group_members WHERE group_id = $1', [groupId]);
    return r.rows.map((x) => x.user_id);
  }

  // Baca opsi jadwal: deliver_at (ISO) atau delay_minutes. Return null = kirim sekarang.
  function parseSchedule(body) {
    let when = null;
    if (body.deliver_at) when = new Date(body.deliver_at);
    else if (body.delay_minutes) when = new Date(Date.now() + parseFloat(body.delay_minutes) * 60000);
    if (!when) return { when: null };
    if (isNaN(when.getTime())) return { error: 'Format waktu jadwal tidak valid.' };
    if (when.getTime() - Date.now() < 5000) return { when: null };
    if (when.getTime() - Date.now() > 366 * 24 * 3600 * 1000) return { error: 'Jadwal maksimal 1 tahun ke depan.' };
    return { when };
  }
  const cleanKind = (k) => (k === 'sticker' ? 'sticker' : 'text');
  const previewOf = (text, n) => (text ? text.slice(0, 200) : n ? `[${n} lampiran]` : '');

  /* ------------------------------------------------------------------ */
  /* Pengiriman inti (dipakai langsung & oleh scheduler)                 */
  /* ------------------------------------------------------------------ */
  async function deliverDirect({ senderId, senderName, receiverId, text, kind, attachmentIds }) {
    const ins = await pool.query('INSERT INTO messages (sender_id, receiver_id, message, kind) VALUES ($1, $2, $3, $4) RETURNING id',
      [senderId, receiverId, text, kind]);
    const id = ins.rows[0].id;
    if (attachmentIds.length) await pool.query('UPDATE attachments SET message_id = $1, scheduled_id = NULL WHERE id = ANY($2::int[])', [id, attachmentIds]);
    await ensureMutual(senderId, receiverId); // penerima otomatis menyimpan pengirim
    const msg = await fetchDirect(id);
    totalMessagesCounter.inc();
    toUser(receiverId, `chat_${receiverId}`, msg);
    io.emit('admin:update', { type: 'message_sent' });
    notifyMessageEmail(receiverId, senderName, previewOf(text, attachmentIds.length));
    return msg;
  }

  async function deliverGroup({ senderId, senderName, groupId, text, kind, attachmentIds }) {
    const ins = await pool.query('INSERT INTO chat_group_messages (group_id, sender_id, message, kind) VALUES ($1, $2, $3, $4) RETURNING id',
      [groupId, senderId, text, kind]);
    const id = ins.rows[0].id;
    if (attachmentIds.length) await pool.query('UPDATE attachments SET group_message_id = $1, scheduled_id = NULL WHERE id = ANY($2::int[])', [id, attachmentIds]);
    const msg = await fetchGroupMsg(id);
    totalMessagesCounter.inc();
    const members = (await memberIds(groupId)).filter((u) => u !== senderId);
    if (members.length) io.to(members.map((u) => 'user_' + u)).emit('group_msg', msg);
    io.emit('admin:update', { type: 'message_sent' });
    members.forEach((u) => notifyMessageEmail(u, `${senderName} (grup)`, previewOf(text, attachmentIds.length)));
    return msg;
  }

  /* ------------------------------------------------------------------ */
  /* SCHEDULER: pesan terjadwal + auto-hapus peringatan kedaluwarsa       */
  /* ------------------------------------------------------------------ */
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const due = await pool.query(
        `UPDATE scheduled_messages SET status = 'sending'
         WHERE id IN (SELECT id FROM scheduled_messages WHERE status = 'pending' AND deliver_at <= NOW()
                      ORDER BY deliver_at LIMIT 50 FOR UPDATE SKIP LOCKED)
         RETURNING *`);
      for (const s of due.rows) {
        try {
          const u = await pool.query("SELECT id, username, role FROM users WHERE id = $1 AND status = 'active'", [s.sender_id]);
          if (!u.rowCount) throw new Error('Pengirim tidak aktif.');
          const att = await pool.query('SELECT id FROM attachments WHERE scheduled_id = $1 AND deleted_at IS NULL ORDER BY id', [s.id]);
          const attachmentIds = att.rows.map((a) => a.id);
          if (s.group_id) {
            if (!(await isMember(s.group_id, s.sender_id))) throw new Error('Pengirim sudah bukan anggota grup.');
            await deliverGroup({ senderId: s.sender_id, senderName: u.rows[0].username, groupId: s.group_id, text: s.message, kind: s.kind, attachmentIds });
          } else {
            const chk = await canMessage(u.rows[0], s.receiver_id);
            if (!chk.ok) throw new Error(chk.error);
            await deliverDirect({ senderId: s.sender_id, senderName: u.rows[0].username, receiverId: s.receiver_id, text: s.message, kind: s.kind, attachmentIds });
          }
          await pool.query("UPDATE scheduled_messages SET status = 'sent', sent_at = NOW() WHERE id = $1", [s.id]);
        } catch (e) {
          console.error('[scheduler] gagal kirim #' + s.id, e.message);
          await pool.query("UPDATE scheduled_messages SET status = 'failed', error = $2 WHERE id = $1", [s.id, e.message.slice(0, 250)]);
        }
      }
      // Peringatan admin yang kedaluwarsa dihapus otomatis
      const exp = await pool.query(
        `UPDATE admin_warnings SET deleted_at = NOW()
         WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at <= NOW() RETURNING id`);
      exp.rows.forEach((w) => io.to('authed').emit('warning:expired', { id: w.id }));
    } catch (e) {
      console.error('[scheduler]', e.message);
    } finally {
      ticking = false;
    }
  }
  function startScheduler() { setInterval(tick, 15000); tick(); }

  /* ------------------------------------------------------------------ */
  /* PROFIL & KONTAK                                                     */
  /* ------------------------------------------------------------------ */
  app.get('/api/me', authenticateToken, wrap(async (req, res) => {
    const r = await pool.query('SELECT id, username, email, notify_email, email_notifications FROM users WHERE id = $1', [req.user.id]);
    res.json({ ...r.rows[0], smtp: !!transporter });
  }));

  app.patch('/api/me', authenticateToken, wrap(async (req, res) => {
    const { email_notifications } = req.body || {};
    if (typeof email_notifications === 'boolean') {
      await pool.query('UPDATE users SET email_notifications = $1 WHERE id = $2', [email_notifications, req.user.id]);
    }
    res.json({ message: 'Pengaturan notifikasi disimpan.' });
  }));

  const mailLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Terlalu banyak permintaan kode. Coba lagi dalam 1 jam.' } });
  const hashCode = (c) => crypto.createHash('sha256').update(String(c) + JWT_SECRET()).digest('hex');
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  // Ganti email notifikasi: email akun langsung aktif; email lain dikirimi kode verifikasi dulu.
  app.post('/api/me/notify-email', authenticateToken, mailLimiter, wrap(async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Format email tidak valid.' });
    const me = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    if (email === String(me.rows[0].email).toLowerCase()) {
      await pool.query('UPDATE users SET notify_email = NULL WHERE id = $1', [req.user.id]);
      return res.json({ message: 'Notifikasi memakai email akun Anda.', verified: true });
    }
    if (!transporter) return res.status(503).json({ error: 'SMTP belum dikonfigurasi di server, email lain belum bisa diverifikasi.' });
    const code = String(crypto.randomInt(100000, 1000000));
    await pool.query(
      `INSERT INTO email_verifications (user_id, new_email, code_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '15 minutes')
       ON CONFLICT (user_id) DO UPDATE SET new_email = $2, code_hash = $3, attempts = 0, expires_at = NOW() + INTERVAL '15 minutes'`,
      [req.user.id, email, hashCode(code)]);
    await sendMail(email, 'Kode verifikasi email notifikasi', `Kode verifikasi Anda: ${code}\n\nBerlaku 15 menit. Abaikan email ini bila Anda tidak memintanya.`);
    res.json({ message: 'Kode verifikasi dikirim ke ' + email + '.', verified: false });
  }));

  app.post('/api/me/notify-email/verify', authenticateToken, wrap(async (req, res) => {
    const code = String((req.body || {}).code || '').trim();
    const r = await pool.query('SELECT * FROM email_verifications WHERE user_id = $1', [req.user.id]);
    if (!r.rowCount || new Date(r.rows[0].expires_at) < new Date()) return res.status(400).json({ error: 'Kode kedaluwarsa. Minta kode baru.' });
    if (r.rows[0].attempts >= 5) return res.status(429).json({ error: 'Terlalu banyak percobaan. Minta kode baru.' });
    if (hashCode(code) !== r.rows[0].code_hash) {
      await pool.query('UPDATE email_verifications SET attempts = attempts + 1 WHERE user_id = $1', [req.user.id]);
      return res.status(400).json({ error: 'Kode salah.' });
    }
    await pool.query('UPDATE users SET notify_email = $1 WHERE id = $2', [r.rows[0].new_email, req.user.id]);
    await pool.query('DELETE FROM email_verifications WHERE user_id = $1', [req.user.id]);
    res.json({ message: 'Email notifikasi diperbarui.' });
  }));

  const contactLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, message: { error: 'Terlalu banyak percobaan tambah kontak. Coba lagi nanti.' } });

  app.get('/api/contacts', authenticateToken, wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT u.id, u.username, u.email, u.status, u.last_activity, c.created_at AS added_at
       FROM contacts c JOIN users u ON u.id = c.contact_id
       WHERE c.owner_id = $1 AND u.status = 'active' ORDER BY u.username ASC`, [req.user.id]);
    res.json(r.rows);
  }));

  app.post('/api/contacts', authenticateToken, contactLimiter, wrap(async (req, res) => {
    const q = String((req.body || {}).query || '').trim().toLowerCase();
    if (!q) return res.status(400).json({ error: 'Isi username atau email user yang ingin ditambahkan.' });
    const r = await pool.query("SELECT id, username, role FROM users WHERE (LOWER(username) = $1 OR LOWER(email) = $1) AND status = 'active'", [q]);
    if (!r.rowCount || r.rows[0].role === 'admin') return res.status(404).json({ error: 'User tidak ditemukan.' });
    const target = r.rows[0];
    if (target.id === req.user.id) return res.status(400).json({ error: 'Tidak bisa menambahkan diri sendiri.' });
    await pool.query('INSERT INTO contacts (owner_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, target.id]);
    res.status(201).json({ message: `${target.username} ditambahkan ke kontak.`, contact: { id: target.id, username: target.username } });
  }));

  app.delete('/api/contacts/:id', authenticateToken, wrap(async (req, res) => {
    await pool.query('DELETE FROM contacts WHERE owner_id = $1 AND contact_id = $2', [req.user.id, req.params.id]);
    res.json({ message: 'Kontak dihapus.' });
  }));

  // Override GET /api/users bawaan: sidebar chat hanya menampilkan KONTAK.
  app.get('/api/users', authenticateToken, wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT u.id, u.username, u.email, u.status, u.last_activity
       FROM contacts c JOIN users u ON u.id = c.contact_id
       WHERE c.owner_id = $1 AND u.status = 'active' AND u.username ILIKE $2 ORDER BY u.username ASC`,
      [req.user.id, `%${req.query.search || ''}%`]);
    res.json(r.rows);
  }));

  /* ------------------------------------------------------------------ */
  /* PESAN PRIBADI (teks, sticker, multi-file, voice note, terjadwal)    */
  /* ------------------------------------------------------------------ */
  app.get('/api/messages', authenticateToken, wrap(async (req, res) => {
    const withId = parseInt(req.query.with, 10);
    if (!withId) return res.status(400).json({ error: 'Parameter query `with` diperlukan.' });
    const r = await pool.query(
      `SELECT m.id, m.sender_id, m.receiver_id, m.message, m.kind, m.created_at, m.deleted_at, m.deleted_by,
              u1.username AS sender_name, u2.username AS receiver_name, ${ATT_SQL('message_id')}
       FROM messages m JOIN users u1 ON m.sender_id = u1.id JOIN users u2 ON m.receiver_id = u2.id
       WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)
       ORDER BY m.created_at ASC, m.id ASC`, [req.user.id, withId]);
    res.json(r.rows.map((m) => (m.deleted_at ? { ...m, message: 'Pesan ini telah dihapus.', attachments: [] } : m)));
  }));

  app.post('/api/messages', authenticateToken, parseUpload, wrap(async (req, res) => {
    const files = uploadedFiles(req);
    const body = req.body || {};
    const receiverId = parseInt(body.receiver_id, 10);
    const text = String(body.message || '').trim();
    const kind = cleanKind(body.kind);
    if (!receiverId || (!text && !files.length)) { discard(files); return res.status(400).json({ error: 'Penerima dan pesan/lampiran wajib diisi.' }); }
    if (kind === 'sticker' && (files.length || text.length > 16)) { discard(files); return res.status(400).json({ error: 'Sticker tidak valid.' }); }

    const chk = await canMessage(req.user, receiverId);
    if (!chk.ok) { discard(files); return res.status(403).json({ error: chk.error }); }
    const sch = parseSchedule(body);
    if (sch.error) { discard(files); return res.status(400).json({ error: sch.error }); }

    if (sch.when) {
      const s = await pool.query(
        'INSERT INTO scheduled_messages (sender_id, receiver_id, message, kind, deliver_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, deliver_at',
        [req.user.id, receiverId, text, kind, sch.when.toISOString()]);
      await saveAttachments(req.user.id, files, s.rows[0].id);
      return res.status(202).json({ scheduled: true, id: s.rows[0].id, deliver_at: s.rows[0].deliver_at });
    }
    const attachmentIds = await saveAttachments(req.user.id, files, null);
    const msg = await deliverDirect({ senderId: req.user.id, senderName: req.user.username, receiverId, text, kind, attachmentIds });
    res.status(201).json(msg);
  }));

  // Saat pesan dihapus (oleh user/admin) lewat route bawaan, file lampirannya ikut dihapus dari disk.
  app.delete('/api/messages/:id(\\d+)', authenticateToken, (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode === 200) removeAttachmentFiles('message_id = $1', [req.params.id]).catch((e) => console.error(e.message));
    });
    next();
  });

  app.get('/api/scheduled', authenticateToken, wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT s.id, s.message, s.kind, s.deliver_at, s.status, s.error, u.username AS receiver_name, g.name AS group_name,
              (SELECT COUNT(*) FROM attachments a WHERE a.scheduled_id = s.id AND a.deleted_at IS NULL)::int AS attachment_count
       FROM scheduled_messages s LEFT JOIN users u ON u.id = s.receiver_id LEFT JOIN chat_groups g ON g.id = s.group_id
       WHERE s.sender_id = $1 AND (s.status IN ('pending','sending') OR (s.status = 'failed' AND s.created_at > NOW() - INTERVAL '2 days'))
       ORDER BY s.deliver_at ASC`, [req.user.id]);
    res.json(r.rows);
  }));

  app.delete('/api/scheduled/:id', authenticateToken, wrap(async (req, res) => {
    const r = await pool.query("UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1 AND sender_id = $2 AND status = 'pending' RETURNING id", [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Pesan terjadwal tidak ditemukan / sudah terkirim.' });
    await removeAttachmentFiles('scheduled_id = $1', [req.params.id]);
    res.json({ message: 'Pesan terjadwal dibatalkan.' });
  }));

  /* ------------------------------------------------------------------ */
  /* FILE (download / tampil inline) — hanya peserta chat/anggota/admin  */
  /* ------------------------------------------------------------------ */
  app.get('/api/files/:id(\\d+)', authQ, wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT a.*, m.sender_id AS m_sender, m.receiver_id AS m_receiver, gm.group_id AS g_id
       FROM attachments a LEFT JOIN messages m ON m.id = a.message_id LEFT JOIN chat_group_messages gm ON gm.id = a.group_message_id
       WHERE a.id = $1 AND a.deleted_at IS NULL`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'File tidak ditemukan.' });
    const a = r.rows[0];
    const uid = req.user.id;
    let allowed = req.user.role === 'admin' || a.uploader_id === uid || a.m_sender === uid || a.m_receiver === uid;
    if (!allowed && a.g_id) allowed = await isMember(a.g_id, uid);
    if (!allowed) return res.status(403).json({ error: 'Akses ditolak.' });

    const full = path.join(UPLOAD_DIR, path.basename(a.stored_name));
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'File fisik tidak ada di server.' });
    const ext = path.extname(a.stored_name).toLowerCase();
    if (INLINE_EXT.has(ext) && !req.query.download) return res.sendFile(full);
    res.download(full, a.original_name);
  }));

  /* ------------------------------------------------------------------ */
  /* GRUP (sisi user)                                                    */
  /* ------------------------------------------------------------------ */
  app.get('/api/groups', authenticateToken, wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT g.id, g.name, g.invite_code, g.created_by, my.role,
              (SELECT COUNT(*) FROM chat_group_members x WHERE x.group_id = g.id)::int AS member_count
       FROM chat_groups g JOIN chat_group_members my ON my.group_id = g.id AND my.user_id = $1
       ORDER BY g.name ASC`, [req.user.id]);
    res.json(r.rows);
  }));

  app.post('/api/groups', authenticateToken, wrap(async (req, res) => {
    const name = String((req.body || {}).name || '').trim().slice(0, 80);
    const ids = Array.isArray((req.body || {}).member_ids) ? req.body.member_ids.map(Number).filter(Boolean) : [];
    if (name.length < 2) return res.status(400).json({ error: 'Nama grup minimal 2 karakter.' });
    let valid = [];
    if (ids.length) {
      const c = await pool.query('SELECT contact_id FROM contacts WHERE owner_id = $1 AND contact_id = ANY($2::int[])', [req.user.id, ids]);
      valid = c.rows.map((x) => x.contact_id);
    }
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const g = await pool.query('INSERT INTO chat_groups (name, invite_code, created_by) VALUES ($1, $2, $3) RETURNING id, name, invite_code', [name, code, req.user.id]);
    await pool.query("INSERT INTO chat_group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')", [g.rows[0].id, req.user.id]);
    for (const uid of valid) {
      await pool.query('INSERT INTO chat_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [g.rows[0].id, uid]);
      toUser(uid, 'group_update', { id: g.rows[0].id });
    }
    io.emit('admin:update', { type: 'group_created' });
    res.status(201).json(g.rows[0]);
  }));

  app.post('/api/groups/join', authenticateToken, wrap(async (req, res) => {
    const code = String((req.body || {}).code || '').trim().toUpperCase();
    const g = await pool.query('SELECT id, name FROM chat_groups WHERE invite_code = $1', [code]);
    if (!g.rowCount) return res.status(404).json({ error: 'Kode grup tidak ditemukan.' });
    await pool.query('INSERT INTO chat_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [g.rows[0].id, req.user.id]);
    io.emit('admin:update', { type: 'group_joined' });
    res.json({ message: `Berhasil bergabung ke grup ${g.rows[0].name}.`, group: g.rows[0] });
  }));

  app.get('/api/groups/:id(\\d+)', authenticateToken, wrap(async (req, res) => {
    if (!(await isMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'Anda bukan anggota grup ini.' });
    const g = await pool.query('SELECT id, name, invite_code, created_by FROM chat_groups WHERE id = $1', [req.params.id]);
    const m = await pool.query(
      `SELECT u.id, u.username, gm.role FROM chat_group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 ORDER BY u.username`, [req.params.id]);
    res.json({ ...g.rows[0], members: m.rows });
  }));

  app.post('/api/groups/:id(\\d+)/members', authenticateToken, wrap(async (req, res) => {
    const me = await pool.query('SELECT role FROM chat_group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!me.rowCount || me.rows[0].role !== 'owner') return res.status(403).json({ error: 'Hanya pembuat grup yang bisa menambah anggota.' });
    const uid = parseInt((req.body || {}).user_id, 10);
    const c = await pool.query('SELECT 1 FROM contacts WHERE owner_id = $1 AND contact_id = $2', [req.user.id, uid]);
    if (!c.rowCount) return res.status(400).json({ error: 'User harus ada di kontak Anda.' });
    await pool.query('INSERT INTO chat_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, uid]);
    toUser(uid, 'group_update', { id: Number(req.params.id) });
    res.json({ message: 'Anggota ditambahkan.' });
  }));

  app.post('/api/groups/:id(\\d+)/leave', authenticateToken, wrap(async (req, res) => {
    await pool.query('DELETE FROM chat_group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Anda keluar dari grup.' });
  }));

  app.get('/api/groups/:id(\\d+)/messages', authenticateToken, wrap(async (req, res) => {
    if (!(await isMember(req.params.id, req.user.id))) return res.status(403).json({ error: 'Anda bukan anggota grup ini.' });
    const r = await pool.query(
      `SELECT m.id, m.group_id, m.sender_id, m.message, m.kind, m.created_at, m.deleted_at, u.username AS sender_name, ${ATT_SQL('group_message_id')}
       FROM chat_group_messages m JOIN users u ON u.id = m.sender_id WHERE m.group_id = $1
       ORDER BY m.created_at ASC, m.id ASC`, [req.params.id]);
    res.json(r.rows.map((m) => (m.deleted_at ? { ...m, message: 'Pesan ini telah dihapus.', attachments: [] } : m)));
  }));

  app.post('/api/groups/:id(\\d+)/messages', authenticateToken, parseUpload, wrap(async (req, res) => {
    const files = uploadedFiles(req);
    const body = req.body || {};
    const text = String(body.message || '').trim();
    const kind = cleanKind(body.kind);
    if (!text && !files.length) { discard(files); return res.status(400).json({ error: 'Pesan atau lampiran wajib diisi.' }); }
    if (kind === 'sticker' && (files.length || text.length > 16)) { discard(files); return res.status(400).json({ error: 'Sticker tidak valid.' }); }
    if (!(await isMember(req.params.id, req.user.id))) { discard(files); return res.status(403).json({ error: 'Anda bukan anggota grup ini.' }); }
    const sch = parseSchedule(body);
    if (sch.error) { discard(files); return res.status(400).json({ error: sch.error }); }

    if (sch.when) {
      const s = await pool.query(
        'INSERT INTO scheduled_messages (sender_id, group_id, message, kind, deliver_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, deliver_at',
        [req.user.id, req.params.id, text, kind, sch.when.toISOString()]);
      await saveAttachments(req.user.id, files, s.rows[0].id);
      return res.status(202).json({ scheduled: true, id: s.rows[0].id, deliver_at: s.rows[0].deliver_at });
    }
    const attachmentIds = await saveAttachments(req.user.id, files, null);
    const msg = await deliverGroup({ senderId: req.user.id, senderName: req.user.username, groupId: Number(req.params.id), text, kind, attachmentIds });
    res.status(201).json(msg);
  }));

  app.delete('/api/groups/:gid(\\d+)/messages/:id(\\d+)', authenticateToken, wrap(async (req, res) => {
    const m = await pool.query('SELECT sender_id FROM chat_group_messages WHERE id = $1 AND group_id = $2', [req.params.id, req.params.gid]);
    if (!m.rowCount) return res.status(404).json({ error: 'Pesan tidak ditemukan.' });
    if (m.rows[0].sender_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Anda hanya bisa menghapus pesan sendiri.' });
    await pool.query('UPDATE chat_group_messages SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2', [req.user.id, req.params.id]);
    await removeAttachmentFiles('group_message_id = $1', [req.params.id]);
    io.to('authed').emit('group_msg_deleted', { id: Number(req.params.id), group_id: Number(req.params.gid) });
    res.json({ message: 'Pesan grup dihapus.' });
  }));

  /* ------------------------------------------------------------------ */
  /* PERINGATAN ADMIN (broadcast / personal, dengan auto-expire)         */
  /* ------------------------------------------------------------------ */
  app.get('/api/warnings', authenticateToken, wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT id, message, expires_at, created_at, (target_user_id IS NULL) AS is_broadcast FROM admin_warnings
       WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) AND (target_user_id IS NULL OR target_user_id = $1)
       ORDER BY created_at DESC LIMIT 20`, [req.user.id]);
    res.json(r.rows);
  }));

  async function createWarning(req, { userId, message, durationMinutes, sendEmail }) {
    const mins = parseFloat(durationMinutes);
    const expires = mins > 0 ? new Date(Date.now() + mins * 60000).toISOString() : null;
    const w = await pool.query(
      'INSERT INTO admin_warnings (admin_id, target_user_id, message, expires_at) VALUES ($1, $2, $3, $4) RETURNING id, message, expires_at, created_at',
      [req.user.id, userId || null, message, expires]);
    const payload = { ...w.rows[0], is_broadcast: !userId };
    if (userId) toUser(userId, 'warning:new', payload); else io.to('authed').emit('warning:new', payload);

    let targets = 0;
    if (sendEmail !== false && transporter) {
      const t = userId
        ? await pool.query("SELECT COALESCE(notify_email, email) AS email FROM users WHERE id = $1 AND status = 'active' AND email_notifications IS NOT FALSE", [userId])
        : await pool.query("SELECT COALESCE(notify_email, email) AS email FROM users WHERE role != 'admin' AND status = 'active' AND email_notifications IS NOT FALSE");
      targets = t.rowCount;
      // kirim di background supaya request admin tidak menunggu SMTP
      (async () => { for (const row of t.rows) await sendMail(row.email, 'Peringatan dari Admin', message); })();
    }
    io.emit('admin:update', { type: 'warning_sent' });
    return { warning: payload, emailTargets: targets };
  }

  // Override POST /api/admin/broadcast bawaan: tidak lagi menyisipkan ke tabel messages,
  // jadi TIDAK muncul sebagai percakapan di chat/grup user, melainkan banner peringatan yang bisa kedaluwarsa.
  app.post('/api/admin/broadcast', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const message = String((req.body || {}).message || '').trim();
    if (!message) return res.status(400).json({ error: 'Isi pesan wajib diisi.' });
    const dur = (req.body || {}).duration_minutes;
    const { emailTargets } = await createWarning(req, { userId: null, message, durationMinutes: dur, sendEmail: (req.body || {}).send_email });
    const cnt = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role != 'admin' AND status = 'active'");
    await logAudit(req.user.id, 'BROADCAST_MESSAGE', 'user', null, `Admin mengirim peringatan broadcast (durasi ${dur > 0 ? dur + ' menit' : 'tanpa batas'})`, req.ip);
    res.json({ message: `Peringatan dikirim ke ${cnt.rows[0].n} user${emailTargets ? ` (+${emailTargets} email)` : ''}.` });
  }));

  app.post('/api/admin/warnings', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    const message = String(b.message || '').trim();
    const userId = b.user_id ? parseInt(b.user_id, 10) : null;
    if (!message) return res.status(400).json({ error: 'Isi peringatan wajib diisi.' });
    if (userId) {
      const t = await pool.query("SELECT id FROM users WHERE id = $1 AND role != 'admin' AND status = 'active'", [userId]);
      if (!t.rowCount) return res.status(404).json({ error: 'User tidak ditemukan / tidak aktif.' });
    }
    const out = await createWarning(req, { userId, message, durationMinutes: b.duration_minutes, sendEmail: b.send_email });
    await logAudit(req.user.id, 'SEND_WARNING', 'user', userId, userId ? 'Admin mengirim peringatan pribadi' : 'Admin mengirim peringatan ke semua user', req.ip);
    res.status(201).json(out.warning);
  }));

  app.get('/api/admin/warnings', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT w.id, w.message, w.expires_at, w.created_at, w.deleted_at, u.username AS target,
              CASE WHEN w.deleted_at IS NOT NULL THEN 'dihapus/kedaluwarsa' ELSE 'aktif' END AS state
       FROM admin_warnings w LEFT JOIN users u ON u.id = w.target_user_id ORDER BY w.id DESC LIMIT 100`);
    res.json(r.rows);
  }));

  app.delete('/api/admin/warnings/:id(\\d+)', authenticateToken, requireAdmin, wrap(async (req, res) => {
    await pool.query('UPDATE admin_warnings SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    io.to('authed').emit('warning:expired', { id: Number(req.params.id) });
    await logAudit(req.user.id, 'DELETE_WARNING', 'warning', req.params.id, 'Admin menarik peringatan', req.ip);
    res.json({ message: 'Peringatan ditarik.' });
  }));

  /* ------------------------------------------------------------------ */
  /* ADMIN: GRUP                                                         */
  /* ------------------------------------------------------------------ */
  app.get('/api/admin/groups', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT g.id, g.name, g.invite_code, g.created_at, u.username AS created_by_name,
              (SELECT COUNT(*) FROM chat_group_members x WHERE x.group_id = g.id)::int AS member_count,
              (SELECT COUNT(*) FROM chat_group_messages x WHERE x.group_id = g.id)::int AS message_count
       FROM chat_groups g LEFT JOIN users u ON u.id = g.created_by ORDER BY g.id DESC`);
    res.json(r.rows);
  }));

  app.get('/api/admin/groups/:id(\\d+)', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const g = await pool.query('SELECT id, name, invite_code, created_at FROM chat_groups WHERE id = $1', [req.params.id]);
    if (!g.rowCount) return res.status(404).json({ error: 'Grup tidak ditemukan.' });
    const members = await pool.query(
      `SELECT u.id, u.username, u.email, gm.role, gm.joined_at FROM chat_group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 ORDER BY gm.role DESC, u.username`, [req.params.id]);
    const msgs = await pool.query(
      `SELECT m.id, m.message, m.kind, m.created_at, m.deleted_at, u.username AS sender_name, ${ATT_SQL('group_message_id')}
       FROM chat_group_messages m JOIN users u ON u.id = m.sender_id WHERE m.group_id = $1 ORDER BY m.id DESC LIMIT 100`, [req.params.id]);
    res.json({ ...g.rows[0], members: members.rows, messages: msgs.rows });
  }));

  app.patch('/api/admin/groups/:id(\\d+)', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const name = String((req.body || {}).name || '').trim().slice(0, 80);
    if (name.length < 2) return res.status(400).json({ error: 'Nama grup minimal 2 karakter.' });
    const old = await pool.query('SELECT name FROM chat_groups WHERE id = $1', [req.params.id]);
    if (!old.rowCount) return res.status(404).json({ error: 'Grup tidak ditemukan.' });
    await pool.query('UPDATE chat_groups SET name = $1 WHERE id = $2', [name, req.params.id]);
    await logAudit(req.user.id, 'RENAME_GROUP', 'group', req.params.id, `Nama grup "${old.rows[0].name}" diubah menjadi "${name}"`, req.ip);
    (await memberIds(req.params.id)).forEach((u) => toUser(u, 'group_update', { id: Number(req.params.id) }));
    io.emit('admin:update', { type: 'group_renamed' });
    res.json({ message: 'Nama grup diperbarui.' });
  }));

  app.delete('/api/admin/group-messages/:id(\\d+)', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const r = await pool.query('UPDATE chat_group_messages SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING group_id', [req.user.id, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Pesan tidak ditemukan.' });
    await removeAttachmentFiles('group_message_id = $1', [req.params.id]);
    await logAudit(req.user.id, 'DELETE_GROUP_MESSAGE', 'group_message', req.params.id, 'Admin menghapus pesan grup', req.ip);
    io.to('authed').emit('group_msg_deleted', { id: Number(req.params.id), group_id: r.rows[0].group_id });
    res.json({ message: 'Pesan grup dihapus.' });
  }));

  /* ------------------------------------------------------------------ */
  /* ADMIN: MEDIA & BACKUP                                               */
  /* ------------------------------------------------------------------ */
  const MEDIA_SELECT = `
    SELECT a.id, a.kind, a.original_name, a.stored_name, a.mime, a.size, a.created_at,
           COALESCE(u1.username, ug.username, ua.username) AS sender, u2.username AS receiver, g.name AS group_name
    FROM attachments a
    LEFT JOIN messages m ON m.id = a.message_id
    LEFT JOIN users u1 ON u1.id = m.sender_id
    LEFT JOIN users u2 ON u2.id = m.receiver_id
    LEFT JOIN chat_group_messages gm ON gm.id = a.group_message_id
    LEFT JOIN users ug ON ug.id = gm.sender_id
    LEFT JOIN chat_groups g ON g.id = gm.group_id
    LEFT JOIN users ua ON ua.id = a.uploader_id
    WHERE a.deleted_at IS NULL`;

  app.get('/api/admin/media', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const search = `%${req.query.search || ''}%`;
    const kind = ['image', 'video', 'audio', 'voice', 'file'].includes(req.query.kind) ? req.query.kind : null;
    const filter = `AND (a.original_name ILIKE $1 OR u1.username ILIKE $1 OR u2.username ILIKE $1 OR g.name ILIKE $1) ${kind ? "AND a.kind = $4" : ''}`;
    const params = kind ? [search, limit, (page - 1) * limit, kind] : [search, limit, (page - 1) * limit];
    const rows = await pool.query(`${MEDIA_SELECT} ${filter} ORDER BY a.id DESC LIMIT $2 OFFSET $3`, params);
    const total = await pool.query(
      `SELECT COUNT(*)::int AS n FROM (${MEDIA_SELECT} ${filter.replace('$4', '$2')}) t`, kind ? [search, kind] : [search]);
    const sum = await pool.query('SELECT COALESCE(SUM(size),0)::bigint AS bytes FROM attachments WHERE deleted_at IS NULL');
    res.json({ media: rows.rows.map(({ stored_name, ...x }) => x), total: total.rows[0].n, page, limit, total_bytes: Number(sum.rows[0].bytes) });
  }));

  app.delete('/api/admin/media/:id(\\d+)', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const n = await removeAttachmentFiles('id = $1', [req.params.id]);
    if (!n) return res.status(404).json({ error: 'File tidak ditemukan.' });
    await logAudit(req.user.id, 'DELETE_MEDIA', 'attachment', req.params.id, 'Admin menghapus file/media', req.ip);
    io.emit('message_deleted', { id: 0 });
    io.emit('admin:update', { type: 'media_deleted' });
    res.json({ message: 'File dihapus.' });
  }));

  app.get('/api/admin/backups', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const r = await pool.query(
      `SELECT b.id, b.filename, b.size, b.file_count, b.created_at, u.username AS created_by_name
       FROM backups b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC`);
    res.json(r.rows);
  }));

  // Buat arsip ZIP: seluruh media (all:true) atau hanya id terpilih (ids:[...])
  app.post('/api/admin/backups', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const { ids, all } = req.body || {};
    let rows;
    if (all) rows = (await pool.query(`${MEDIA_SELECT} ORDER BY a.id`)).rows;
    else if (Array.isArray(ids) && ids.length) rows = (await pool.query(`${MEDIA_SELECT} AND a.id = ANY($1::int[]) ORDER BY a.id`, [ids.map(Number).filter(Boolean)])).rows;
    else return res.status(400).json({ error: 'Pilih file atau gunakan opsi backup semua.' });
    if (!rows.length) return res.status(400).json({ error: 'Tidak ada file untuk di-backup.' });

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const filename = `backup_${all ? 'semua' : 'pilihan'}_${stamp}_${crypto.randomBytes(3).toString('hex')}.zip`;
    const fullPath = path.join(BACKUP_DIR, filename);
    const out = fs.createWriteStream(fullPath);
    const archive = archiver('zip', { zlib: { level: 1 } });
    const manifest = [];
    let count = 0;
    archive.pipe(out);
    for (const a of rows) {
      const src = path.join(UPLOAD_DIR, path.basename(a.stored_name));
      const entry = { id: a.id, name: a.original_name, kind: a.kind, sender: a.sender, receiver: a.receiver, group: a.group_name, sent_at: a.created_at, included: false };
      if (fs.existsSync(src)) {
        const ts = new Date(a.created_at).toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const zipName = `${a.kind}/${ts}_${a.id}_${String(a.original_name).replace(/[^\w.\- ]/g, '_')}`;
        archive.file(src, { name: zipName });
        entry.included = true; entry.path = zipName; count++;
      }
      manifest.push(entry);
    }
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    await new Promise((resolve, reject) => { out.on('close', resolve); out.on('error', reject); archive.on('error', reject); archive.finalize(); });

    const size = fs.statSync(fullPath).size;
    const b = await pool.query('INSERT INTO backups (filename, size, file_count, created_by) VALUES ($1, $2, $3, $4) RETURNING id, filename, size, file_count, created_at',
      [filename, size, count, req.user.id]);
    await logAudit(req.user.id, 'CREATE_BACKUP', 'backup', b.rows[0].id, `Admin membuat backup ${count} file (${filename})`, req.ip);
    res.status(201).json(b.rows[0]);
  }));

  app.get('/api/admin/backups/:id(\\d+)/download', authQ, requireAdmin, wrap(async (req, res) => {
    const r = await pool.query('SELECT filename FROM backups WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Backup tidak ditemukan.' });
    const full = path.join(BACKUP_DIR, path.basename(r.rows[0].filename));
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'File backup hilang dari server.' });
    await logAudit(req.user.id, 'DOWNLOAD_BACKUP', 'backup', req.params.id, `Admin mengunduh ${r.rows[0].filename}`, req.ip);
    res.download(full, r.rows[0].filename);
  }));

  app.delete('/api/admin/backups/:id(\\d+)', authenticateToken, requireAdmin, wrap(async (req, res) => {
    const r = await pool.query('DELETE FROM backups WHERE id = $1 RETURNING filename', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Backup tidak ditemukan.' });
    fs.unlink(path.join(BACKUP_DIR, path.basename(r.rows[0].filename)), () => {});
    await logAudit(req.user.id, 'DELETE_BACKUP', 'backup', req.params.id, `Admin menghapus arsip ${r.rows[0].filename}`, req.ip);
    res.json({ message: 'Arsip backup dihapus.' });
  }));

  console.log('[features] route tambahan terpasang.');
};
