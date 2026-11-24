'use strict';
/**
 * Self-hosted messenger server.
 *  - REST: auth, chats, history, uploads, file download
 *  - WebSocket: realtime messages, typing, read receipts, presence, WebRTC call signalling
 *  - Storage: JSON file (data/db.json) + files on disk (data/uploads)
 */
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const { WebSocketServer } = require('ws');
const multer = require('multer');

const scrypt = util.promisify(crypto.scrypt);

// ───────────────────────── config ─────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 100;
const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const RING_TIMEOUT = 45 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function iceServers() {
  const list = [];
  const stun = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (stun.length) list.push({ urls: stun });
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  return list;
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ───────────────────────── storage ─────────────────────────
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, sessions: {}, chats: {}, messages: {}, reads: {}, files: {}, seq: {} };
try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error('Cannot read database:', e);
    process.exit(1);
  }
}

let saveTimer = null;
function writeDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeDb(); } catch (e) { console.error('DB save error:', e); }
  }, 400);
}
function flushAndExit() {
  try { if (saveTimer) clearTimeout(saveTimer); writeDb(); } catch (e) { console.error(e); }
  process.exit(0);
}
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);

const newId = () => crypto.randomBytes(9).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ───────────────────────── helpers ─────────────────────────
const userSockets = new Map(); // userId -> Set<ws>
const isOnline = (uid) => (userSockets.get(uid)?.size || 0) > 0;

function colorFor(seed) {
  const h = parseInt(sha256(seed).slice(0, 6), 16) % 360;
  return `hsl(${h} 55% 48%)`;
}

function pubUser(u) {
  if (!u) return { id: 'deleted', username: '', name: 'Удалён', color: '#888', online: false, lastSeen: 0 };
  const profile = db.profiles?.[u.id] || {};
  return { id: u.id, username: u.username, name: u.name, color: u.color, avatar: profile.avatar || '', status: profile.status || '', statusImage: profile.statusImage || '', online: isOnline(u.id), lastSeen: u.lastSeen || 0, admin: !!db.adminId && u.id === db.adminId };
}

function msgView(m) {
  if (m.deleted) return { id: m.id, chatId: m.chatId, seq: m.seq, from: m.from, ts: m.ts, type: m.type, deleted: true };
  return m;
}

function chatView(chat, uid) {
  const msgs = db.messages[chat.id] || [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const reads = db.reads[chat.id] || {};
  const readSeq = reads[uid] || 0;
  let unread = 0;
  for (let i = msgs.length - 1; i >= 0 && msgs[i].seq > readSeq; i--) {
    if (msgs[i].from !== uid && msgs[i].type !== 'system' && !msgs[i].deleted) unread++;
  }
  return {
    id: chat.id,
    type: chat.type,
    title: chat.title || '',
    owner: chat.owner || null,
    members: chat.members.map((id) => pubUser(db.users[id])),
    last: last ? msgView(last) : null,
    unread,
    reads,
    updated: last ? last.ts : chat.createdAt,
  };
}

function memberChat(uid, chatId) {
  const c = db.chats[chatId];
  return c && c.members.includes(uid) ? c : null;
}

function sendTo(uid, obj) {
  const set = userSockets.get(uid);
  if (!set) return;
  const s = JSON.stringify(obj);
  for (const w of set) if (w.readyState === 1) w.send(s);
}
function sendChat(chat, obj, exceptUid) {
  for (const uid of chat.members) if (uid !== exceptUid) sendTo(uid, obj);
}

function addMessage(chat, from, fields) {
  const seq = (db.seq[chat.id] = (db.seq[chat.id] || 0) + 1);
  const m = { id: newId(), chatId: chat.id, seq, from, ts: Date.now(), ...fields };
  (db.messages[chat.id] ||= []).push(m);
  const reads = (db.reads[chat.id] ||= {});
  reads[from] = seq; // author has read their own message
  if (fields.type === 'text') {
    db.activity ||= {};
    db.wallets ||= {};
    const activity = db.activity[from] ||= { messages: 0 };
    activity.messages = (activity.messages || 0) + 1;
    if (activity.messages % 10 === 0) db.wallets[from] = (db.wallets[from] || 0) + 3;
  }
  save();
  return m;
}

function broadcastMessage(chat, m, tmp) {
  sendChat(chat, { t: 'message', message: msgView(m), tmp: tmp || undefined });
}

function systemMessage(chat, actorId, text) {
  const m = addMessage(chat, actorId, { type: 'system', text });
  broadcastMessage(chat, m);
}

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function replySnapshot(chat, id) {
  if (typeof id !== 'string') return undefined;
  const msgs = db.messages[chat.id] || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].id === id) {
      const o = msgs[i];
      if (o.deleted) return undefined;
      const text = o.type === 'text' ? o.text.slice(0, 120) : o.caption ? o.caption.slice(0, 120) : '';
      return { id: o.id, from: o.from, type: o.type, text, name: o.file?.name };
    }
  }
  return undefined;
}

function sanitizeFilename(name) {
  let n = String(name || 'file');
  // multipart names often arrive latin1-decoded
  if (![...n].some((ch) => ch.charCodeAt(0) > 255)) {
    const fixed = Buffer.from(n, 'latin1').toString('utf8');
    if (!fixed.includes('�')) n = fixed;
  }
  n = n.replace(/[\\/\u0000-\u001F<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return (n || 'file').slice(0, 200);
}

const INLINE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/ogg',
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/x-m4a',
]);
const normMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();

function sniffContainer(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'ebml'; // webm / matroska
    if (b.toString('latin1', 4, 8) === 'ftyp') return 'isobmff'; // mp4 / m4a / mov
    if (b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  } catch { /* unreadable: treat as unknown */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return null;
}

// ───────────────────────── http app ─────────────────────────
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
      "media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  next();
});

function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !originOk(req)) return res.status(403).json({ error: 'Запрос отклонён' });
  next();
});
app.use(express.json({ limit: '4mb' }));

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
    }
  }
  return out;
}
function userFromReq(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!sid) return null;
  const key = sha256(sid);
  const s = db.sessions[key];
  if (!s) return null;
  if (Date.now() - s.created > SESSION_TTL) { delete db.sessions[key]; save(); return null; }
  return db.users[s.userId] || null;
}
function auth(req, res, next) {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Требуется вход' });
  if (db.bans?.[u.id]) return res.status(403).json({ error: 'Аккаунт заблокирован: ' + (db.bans[u.id].reason || 'нарушение правил') });
  req.user = u;
  next();
}

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++;
  return h.n > max;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, 60000).unref();

function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[sha256(token)] = { userId: user.id, created: Date.now() };
  save();
  res.setHeader('Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}${req.secure ? '; Secure' : ''}`);
}

async function hashPassword(pw, salt) {
  return (await scrypt(pw, salt, 64)).toString('hex');
}

app.post('/api/register', async (req, res) => {
  try {
    if (limited('reg:' + req.ip, 10, 3600e3)) return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
    const { username, password, name } = req.body || {};
    const un = String(username || '').trim().toLowerCase();
    const nm = cleanText(name, 40) || un;
    if (!/^[a-z0-9_]{3,24}$/.test(un)) return res.status(400).json({ error: 'Логин: 3–24 символа, латиница, цифры и _' });
    if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
      return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
    }
    if (Object.values(db.users).some((u) => u.username === un)) return res.status(409).json({ error: 'Этот логин уже занят' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: newId(), username: un, name: nm, color: colorFor(un),
      salt, hash: await hashPassword(password, salt), createdAt: Date.now(), lastSeen: Date.now(),
    };
    db.users[user.id] = user;
    if (!db.adminId && un === 'zeronoice') db.adminId = user.id;
    startSession(req, res, user);
    save();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    if (limited('login:' + req.ip, 15, 5 * 60e3)) return res.status(429).json({ error: 'Слишком много попыток, подождите несколько минут' });
    const { username, password } = req.body || {};
    const un = String(username || '').trim().toLowerCase();
    const user = Object.values(db.users).find((u) => u.username === un);
    const pw = typeof password === 'string' ? password.slice(0, 200) : '';
    const hash = await hashPassword(pw, user ? user.salt : 'x'.repeat(32));
    const ok = user && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
    if (!ok) return res.status(401).json({ error: 'Неверный логин или пароль' });
    if (db.bans?.[user.id]) return res.status(403).json({ error: 'Аккаунт заблокирован: ' + (db.bans[user.id].reason || 'нарушение правил') });
    startSession(req, res, user);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req.headers.cookie).sid;
  if (sid) { delete db.sessions[sha256(sid)]; save(); }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/bootstrap', auth, (req, res) => {
  const uid = req.user.id;
  const chats = Object.values(db.chats).filter((c) => c.members.includes(uid)).map((c) => chatView(c, uid));
  res.json({ me: pubUser(req.user), chats, iceServers: iceServers(), maxUploadMB: MAX_UPLOAD_MB });
});

app.post('/api/profile', auth, (req, res) => {
  const name = cleanText(req.body?.name, 40);
  if (!name) return res.status(400).json({ error: 'Введите имя' });
  req.user.name = name;
  save();
  for (const c of Object.values(db.chats)) {
    if (c.members.includes(req.user.id)) for (const uid of c.members) sendTo(uid, { t: 'chat', chat: chatView(c, uid) });
  }
  res.json({ me: pubUser(req.user) });
});

app.get('/api/users', auth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ users: [] });
  const users = Object.values(db.users)
    .filter((u) => u.id !== req.user.id && (u.username.includes(q) || u.name.toLowerCase().includes(q)))
    .slice(0, 20).map(pubUser);
  res.json({ users });
});

app.get('/api/chats/:id', auth, (req, res) => {
  const chat = memberChat(req.user.id, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  res.json({ chat: chatView(chat, req.user.id) });
});

app.post('/api/chats', auth, (req, res) => {
  const uid = req.user.id;
  const { type } = req.body || {};
  if (type === 'direct') {
    const other = db.users[req.body.userId];
    if (!other || other.id === uid) return res.status(400).json({ error: 'Пользователь не найден' });
    let chat = Object.values(db.chats).find((c) => c.type === 'direct' && c.members.includes(uid) && c.members.includes(other.id));
    if (!chat) {
      chat = { id: newId(), type: 'direct', members: [uid, other.id], createdAt: Date.now() };
      db.chats[chat.id] = chat;
      save();
    }
    return res.json({ chat: chatView(chat, uid) });
  }
  if (type === 'group') {
    const title = cleanText(req.body.title, 60);
    if (!title) return res.status(400).json({ error: 'Введите название группы' });
    const ids = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).filter((id) => db.users[id] && id !== uid))].slice(0, 199);
    if (!ids.length) return res.status(400).json({ error: 'Добавьте хотя бы одного участника' });
    const chat = { id: newId(), type: 'group', title, owner: uid, members: [uid, ...ids], createdAt: Date.now() };
    db.chats[chat.id] = chat;
    save();
    systemMessage(chat, uid, `${req.user.name} создал(а) группу «${title}»`);
    return res.json({ chat: chatView(chat, uid) });
  }
  res.status(400).json({ error: 'Неверный запрос' });
});

app.post('/api/chats/:id/members', auth, (req, res) => {
  const chat = memberChat(req.user.id, req.params.id);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Группа не найдена' });
  const add = [...new Set((Array.isArray(req.body?.userIds) ? req.body.userIds : []).filter((id) => db.users[id] && !chat.members.includes(id)))];
  if (!add.length) return res.status(400).json({ error: 'Некого добавлять' });
  if (chat.members.length + add.length > 200) return res.status(400).json({ error: 'Максимум 200 участников' });
  chat.members.push(...add);
  save();
  systemMessage(chat, req.user.id, `${req.user.name} добавил(а): ${add.map((id) => db.users[id].name).join(', ')}`);
  for (const uid of chat.members) sendTo(uid, { t: 'chat', chat: chatView(chat, uid) });
  res.json({ chat: chatView(chat, req.user.id) });
});

app.post('/api/chats/:id/leave', auth, (req, res) => {
  const uid = req.user.id;
  const chat = memberChat(uid, req.params.id);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'Группа не найдена' });
  chat.members = chat.members.filter((id) => id !== uid);
  sendTo(uid, { t: 'chat-removed', chatId: chat.id });
  if (!chat.members.length) {
    for (const m of db.messages[chat.id] || []) if (m.file) removeFile(m.file.id);
    delete db.chats[chat.id]; delete db.messages[chat.id]; delete db.reads[chat.id]; delete db.seq[chat.id];
    save();
    return res.json({ ok: true });
  }
  if (chat.owner === uid) chat.owner = chat.members[0];
  save();
  const m = addMessage(chat, uid, { type: 'system', text: `${req.user.name} покинул(а) группу` });
  broadcastMessage(chat, m);
  for (const id of chat.members) sendTo(id, { t: 'chat', chat: chatView(chat, id) });
  res.json({ ok: true });
});

app.get('/api/chats/:id/messages', auth, (req, res) => {
  const chat = memberChat(req.user.id, req.params.id);
  if (!chat) return res.status(404).json({ error: 'Чат не найден' });
  const all = db.messages[chat.id] || [];
  const before = Number(req.query.before) || Infinity;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const older = all.filter((m) => m.seq < before);
  res.json({ messages: older.slice(-limit).map(msgView), more: older.length > limit });
});

// ── uploads ──
const storage = multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, file, cb) => cb(null, newId()) });
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD, files: 1, fields: 12, fieldSize: 4096 } });
const stickerUpload = multer({ storage, limits: { fileSize: 30 * 1024 * 1024, files: 30, fields: 2, fieldSize: 1024 } });
app.post('/api/profile/music', auth, (req,res,next) => {
  upload.single('file')(req,res,err => {
    if(err){const msg=err.code==='LIMIT_FILE_SIZE'?'MP3 больше допустимого размера':'Ошибка загрузки MP3';return res.status(400).json({error:msg});}
    next();
  });
}, (req,res) => {
  const file=req.file;
  if(!file)return res.status(400).json({error:'Выбери MP3-файл'});
  const mime=normMime(file.mimetype);
  if(file.size>30*1024*1024 || !['audio/mpeg','audio/mp4','audio/x-m4a'].includes(mime)){fs.unlink(file.path,()=>{});return res.status(400).json({error:'Поддерживаются MP3 и M4A до 30 МБ'});}
  db.profiles ||= {};
  const p=db.profiles[req.user.id] ||= {};
  if(p.musicFileId)removeFile(p.musicFileId);
  db.files[file.filename]={id:file.filename,owner:req.user.id,scope:'profile',name:sanitizeFilename(file.originalname),mime,size:file.size};
  p.musicFileId=file.filename;save();
  res.json({ok:true,url:'/api/files/'+encodeURIComponent(file.filename)});
});
app.delete('/api/profile/music', auth, (req,res) => {
  const p=db.profiles?.[req.user.id]||{};
  if(p.musicFileId)removeFile(p.musicFileId);
  delete p.musicFileId;save();res.json({ok:true});
});

function removeFile(id) {
  delete db.files[id];
  fs.unlink(path.join(UPLOAD_DIR, id), () => {});
}

app.post('/api/upload', auth, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Файл больше ${MAX_UPLOAD_MB} МБ` : 'Ошибка загрузки файла';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Файл не передан' });
  const reject = (code, error) => { fs.unlink(file.path, () => {}); return res.status(code).json({ error }); };
  const kind = String(req.body.kind || '');
  if (kind === 'post') {
    const mime = normMime(file.mimetype);
    if (!INLINE_MIME.has(mime) || (!mime.startsWith('image/') && !mime.startsWith('video/'))) return reject(400, 'Поддерживаются PNG, JPG, GIF, WebP, MP4, WebM и MOV');
    const info = { id: file.filename, name: sanitizeFilename(file.originalname), size: file.size, mime };
    db.files[info.id] = { id: info.id, owner: req.user.id, scope: 'feed', name: info.name, mime: info.mime, size: info.size };
    save();
    return res.json({ ok: true, file: info });
  }
  const chat = memberChat(req.user.id, String(req.body.chatId || ''));
  if (!chat) return reject(403, 'Нет доступа к чату');
  let mime = normMime(file.mimetype);
  if ((kind === 'voice' || kind === 'videonote') && !INLINE_MIME.has(mime)) {
    // Some browsers send recorder types with codec lists that multipart parsers mangle;
    // recover the container from the file signature instead of trusting the header.
    const fam = sniffContainer(file.path);
    const v = kind === 'videonote';
    if (fam === 'ebml') mime = v ? 'video/webm' : 'audio/webm';
    else if (fam === 'isobmff') mime = v ? 'video/mp4' : 'audio/mp4';
    else if (fam === 'ogg') mime = v ? 'video/ogg' : 'audio/ogg';
  }
  let type = 'file';
  if (kind === 'voice' && mime.startsWith('audio/') && INLINE_MIME.has(mime)) type = 'voice';
  else if (kind === 'videonote' && mime.startsWith('video/') && INLINE_MIME.has(mime)) type = 'videonote';
  else if (INLINE_MIME.has(mime)) type = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'audio';
  const duration = Math.max(0, Math.min(Number(req.body.duration) || 0, 3600));
  const info = { id: file.filename, name: sanitizeFilename(file.originalname), size: file.size, mime: mime || 'application/octet-stream', duration };
  db.files[info.id] = { id: info.id, chatId: chat.id, owner: req.user.id, name: info.name, mime: info.mime, size: info.size };
  const m = addMessage(chat, req.user.id, {
    type, file: info, caption: cleanText(req.body.caption, 1000) || undefined,
    reply: replySnapshot(chat, req.body.replyTo),
  });
  broadcastMessage(chat, m, String(req.body.tmp || '').slice(0, 40));
  res.json({ ok: true, message: msgView(m) });
});

app.get('/api/files/:id', auth, (req, res) => {
  const f = db.files[req.params.id];
  const feedAccess = f?.scope === 'feed' && (f.owner === req.user.id || Object.values(db.posts || {}).some(post => post.file?.id === f.id));
  const profileAccess = f?.scope === 'profile' && Object.values(db.profiles || {}).some(p => p.musicFileId === f.id);
  const stickerAccess = f?.scope === 'sticker' && Object.values(db.stickerPacks || {}).some(pack => (pack.stickers || []).some(st => st.fileId === f.id));
  if (!f || (!feedAccess && !profileAccess && !stickerAccess && !memberChat(req.user.id, f.chatId))) return res.status(404).json({ error: 'Файл не найден' });
  const inline = INLINE_MIME.has(f.mime) && req.query.download !== '1';
  res.setHeader('Content-Type', INLINE_MIME.has(f.mime) ? f.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(UPLOAD_DIR, f.id), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Файл не найден' });
  });
});

require('./social')(app, { auth, db, save, newId, cleanText, addMessage, broadcastMessage, upload, stickerUpload, UPLOAD_DIR });

app.use(express.static(PUBLIC_DIR));
app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Неверный JSON' });
  console.error(err);
  res.status(500).json({ error: 'Ошибка сервера' });
});

// ───────────────────────── server + websocket ─────────────────────────
let server;
if (process.env.HTTPS_KEY && process.env.HTTPS_CERT) {
  server = https.createServer({ key: fs.readFileSync(process.env.HTTPS_KEY), cert: fs.readFileSync(process.env.HTTPS_CERT) }, app);
} else {
  server = http.createServer(app);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const reject = (line) => { socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (!String(req.url).startsWith('/ws')) return reject('404 Not Found');
  if (!originOk(req)) return reject('403 Forbidden');
  const user = userFromReq(req);
  if (!user) return reject('401 Unauthorized');
  if (db.bans?.[user.id]) return reject('403 Forbidden');
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userId = user.id;
    wss.emit('connection', ws, req);
  });
});

function contactsOf(uid) {
  const set = new Set();
  for (const c of Object.values(db.chats)) if (c.members.includes(uid)) for (const m of c.members) if (m !== uid) set.add(m);
  return set;
}
function announcePresence(uid) {
  const u = db.users[uid];
  const payload = { t: 'presence', userId: uid, online: isOnline(uid), lastSeen: u?.lastSeen || 0 };
  for (const c of contactsOf(uid)) sendTo(c, payload);
}

// ── calls ──
const calls = new Map(); // callId -> call
const inCall = (uid) => [...calls.values()].some((c) => c.caller === uid || c.callee === uid);

function endCall(call, status) {
  if (!calls.has(call.id)) return;
  calls.delete(call.id);
  clearTimeout(call.timer);
  const payload = { t: 'call:ended', callId: call.id, status };
  sendTo(call.caller, payload);
  sendTo(call.callee, payload);
  const chat = db.chats[call.chatId];
  if (chat) {
    const duration = call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 0;
    const m = addMessage(chat, call.caller, { type: 'call', call: { status, video: call.video, duration } });
    broadcastMessage(chat, m);
  }
}

function handleCall(ws, msg) {
  const uid = ws.userId;
  switch (msg.t) {
    case 'call:invite': {
      const chat = memberChat(uid, msg.chatId);
      if (!chat || chat.type !== 'direct') return ws.send(JSON.stringify({ t: 'call:error', error: 'Звонки доступны только в личных чатах' }));
      const calleeId = chat.members.find((id) => id !== uid);
      if (inCall(uid)) return ws.send(JSON.stringify({ t: 'call:error', error: 'Вы уже в звонке' }));
      const call = {
        id: newId(), chatId: chat.id, caller: uid, callee: calleeId, video: !!msg.video,
        callerWs: ws, calleeWs: null, answeredAt: 0, timer: null,
      };
      if (!isOnline(calleeId) || inCall(calleeId)) {
        const reason = inCall(calleeId) ? 'busy' : 'offline';
        calls.set(call.id, call);
        ws.send(JSON.stringify({ t: 'call:unavailable', reason }));
        endCall(call, 'missed');
        return;
      }
      calls.set(call.id, call);
      call.timer = setTimeout(() => endCall(call, 'missed'), RING_TIMEOUT);
      ws.send(JSON.stringify({ t: 'call:ringing', callId: call.id }));
      sendTo(calleeId, { t: 'call:incoming', callId: call.id, chatId: chat.id, video: call.video, from: pubUser(db.users[uid]) });
      return;
    }
    case 'call:accept': {
      const call = calls.get(msg.callId);
      if (!call || call.callee !== uid || call.answeredAt) return;
      call.answeredAt = Date.now();
      call.calleeWs = ws;
      clearTimeout(call.timer);
      call.callerWs.send(JSON.stringify({ t: 'call:accepted', callId: call.id }));
      for (const w of userSockets.get(uid) || []) {
        if (w !== ws && w.readyState === 1) w.send(JSON.stringify({ t: 'call:closed', callId: call.id }));
      }
      return;
    }
    case 'call:reject': {
      const call = calls.get(msg.callId);
      if (call && call.callee === uid && !call.answeredAt) endCall(call, 'declined');
      return;
    }
    case 'call:end': {
      const call = calls.get(msg.callId);
      if (!call || (call.caller !== uid && call.callee !== uid)) return;
      if (call.answeredAt) endCall(call, 'ended');
      else endCall(call, call.caller === uid ? 'missed' : 'declined');
      return;
    }
    case 'call:signal': {
      const call = calls.get(msg.callId);
      if (!call || !call.answeredAt) return;
      const peer = ws === call.callerWs ? call.calleeWs : ws === call.calleeWs ? call.callerWs : null;
      if (peer && peer.readyState === 1 && msg.data && typeof msg.data === 'object') {
        peer.send(JSON.stringify({ t: 'call:signal', callId: call.id, data: msg.data }));
      }
      return;
    }
    default:
  }
}

function handleMessage(ws, msg) {
  const uid = ws.userId;
  if (db.bans?.[uid]) { try { ws.close(1008, 'Account banned'); } catch {} return; }
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t.startsWith('call:')) return handleCall(ws, msg);
  switch (msg.t) {
    case 'ping':
      return ws.send('{"t":"pong"}');
    case 'send': {
      const chat = memberChat(uid, msg.chatId);
      if (!chat) return;
      const text = cleanText(msg.text, 4000);
      if (!text) return;
      const m = addMessage(chat, uid, { type: 'text', text, reply: replySnapshot(chat, msg.replyTo) });
      broadcastMessage(chat, m, String(msg.tmp || '').slice(0, 40));
      return;
    }
    case 'typing': {
      const chat = memberChat(uid, msg.chatId);
      if (chat) sendChat(chat, { t: 'typing', chatId: chat.id, userId: uid }, uid);
      return;
    }
    case 'react': {
      const chat = memberChat(uid, msg.chatId);
      if (!chat) return;
      const m = (db.messages[chat.id] || []).find(x => x.id === msg.id && !x.deleted);
      const reaction = cleanText(msg.reaction, 24);
      if (!m || !reaction) return;
      m.reactions ||= {};
      m.reactions[reaction] ||= [];
      const list = m.reactions[reaction];
      const i = list.indexOf(uid);
      if (i >= 0) list.splice(i, 1); else list.push(uid);
      if (!list.length) delete m.reactions[reaction];
      save();
      for (const id of chat.members) sendTo(id, { t: 'reaction', chatId: chat.id, id: m.id, reactions: m.reactions });
      return;
    }
    case 'read': {
      const chat = memberChat(uid, msg.chatId);
      if (!chat) return;
      const max = db.seq[chat.id] || 0;
      const seq = Math.min(Number(msg.seq) || 0, max);
      const reads = (db.reads[chat.id] ||= {});
      if (seq > (reads[uid] || 0)) {
        reads[uid] = seq;
        save();
        for (const id of chat.members) sendTo(id, { t: 'read', chatId: chat.id, userId: uid, seq });
      }
      return;
    }
    case 'edit': {
      const chat = memberChat(uid, msg.chatId);
      if (!chat) return;
      const m = (db.messages[chat.id] || []).find((x) => x.id === msg.id);
      const text = cleanText(msg.text, 4000);
      if (!m || m.from !== uid || m.deleted || m.type !== 'text' || !text) return;
      m.text = text;
      m.edited = true;
      save();
      sendChat(chat, { t: 'message-update', message: msgView(m) });
      return;
    }
    case 'delete': {
      const chat = memberChat(uid, msg.chatId);
      if (!chat) return;
      const list = db.messages[chat.id] || [];
      const m = list.find((x) => x.id === msg.id);
      if (!m || m.from !== uid || m.deleted || m.type === 'system') return;
      if (m.file) removeFile(m.file.id);
      for (const x of list) if (x.reply && x.reply.id === m.id) x.reply = { id: m.id, from: m.from, type: 'deleted', text: '' };
      const keep = { id: m.id, chatId: m.chatId, seq: m.seq, from: m.from, ts: m.ts, type: m.type };
      for (const k of Object.keys(m)) delete m[k];
      Object.assign(m, keep, { deleted: true });
      save();
      sendChat(chat, { t: 'message-update', message: msgView(m) });
      for (const x of list) if (x.reply && x.reply.type === 'deleted' && x.reply.id === m.id) sendChat(chat, { t: 'message-update', message: msgView(x) });
      return;
    }
    default:
  }
}

wss.on('connection', (ws) => {
  const uid = ws.userId;
  ws.isAlive = true;
  ws.bucket = { n: 0, t: Date.now() };
  let set = userSockets.get(uid);
  if (!set) userSockets.set(uid, (set = new Set()));
  const wasOnline = set.size > 0;
  set.add(ws);
  if (!wasOnline) announcePresence(uid);
  ws.send(JSON.stringify({ t: 'hello' }));

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    const now = Date.now();
    if (now - ws.bucket.t > 10000) ws.bucket = { n: 0, t: now };
    if (++ws.bucket.n > 400) return; // flood protection
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    try { handleMessage(ws, msg); } catch (e) { console.error('ws handler error:', e); }
  });
  ws.on('close', () => {
    set.delete(ws);
    for (const call of [...calls.values()]) {
      if (call.callerWs === ws || call.calleeWs === ws) endCall(call, call.answeredAt ? 'ended' : 'missed');
    }
    if (!set.size) {
      userSockets.delete(uid);
      if (db.users[uid]) { db.users[uid].lastSeen = Date.now(); save(); }
      announcePresence(uid);
    }
  });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    const proto = process.env.HTTPS_KEY ? 'https' : 'http';
    console.log(`Messenger is running on ${proto}://localhost:${PORT}`);
  });
}

module.exports = { server, app, db, wss };
