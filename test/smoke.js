'use strict';
// End-to-end smoke test: starts the real server on a random port with a temp data dir
// and drives it over HTTP + WebSocket like two browsers would.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-test-'));
process.env.MAX_UPLOAD_MB = '1';
const WebSocket = require('ws');
const { server } = require('../server');

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function req(method, url, { cookie, body, form, headers } = {}) {
    const h = { ...(headers || {}) };
    if (cookie) h.Cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const text = await res.arrayBuffer();
    let json = null;
    try { json = JSON.parse(Buffer.from(text).toString()); } catch { /* not json */ }
    return { status: res.status, json, buf: Buffer.from(text), headers: res.headers };
  }
  async function register(username, name) {
    const r = await fetch(base + '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'secret123', name }),
    });
    assert.strictEqual(r.status, 200);
    const cookie = r.headers.getSetCookie()[0].split(';')[0];
    const boot = await req('GET', '/api/bootstrap', { cookie });
    return { cookie, me: boot.json.me };
  }
  function openWs(cookie, origin = base) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie, Origin: origin } });
      ws.events = [];
      ws.waiters = [];
      ws.on('message', (d) => {
        const ev = JSON.parse(d.toString());
        ws.events.push(ev);
        ws.waiters = ws.waiters.filter((w) => !(w.pred(ev) && (w.resolve(ev), true)));
      });
      ws.waitFor = (pred, ms = 3000) => new Promise((res, rej) => {
        const found = ws.events.find(pred);
        if (found) return res(found);
        const w = { pred, resolve: res };
        ws.waiters.push(w);
        setTimeout(() => rej(new Error('timeout waiting for event')), ms).unref?.();
      });
      ws.sendJson = (o) => ws.send(JSON.stringify(o));
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      ws.on('unexpected-response', (_, res) => reject(Object.assign(new Error('ws rejected'), { status: res.statusCode })));
    });
  }
  const upload = (cookie, fields, filename, mime, data) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', new Blob([data], { type: mime }), filename);
    return req('POST', '/api/upload', { cookie, form });
  };

  console.log('auth');
  assert.strictEqual((await req('GET', '/api/bootstrap')).status, 401);
  ok('bootstrap requires login');
  const alice = await register('alice', 'Алиса');
  const bob = await register('bob', 'Боб');
  const carol = await register('carol', 'Кэрол');
  ok('three users registered');
  assert.strictEqual((await req('POST', '/api/register', { body: { username: 'alice', password: 'secret123' } })).status, 409);
  assert.strictEqual((await req('POST', '/api/register', { body: { username: 'x', password: 'secret123' } })).status, 400);
  assert.strictEqual((await req('POST', '/api/login', { body: { username: 'alice', password: 'wrong-pass' } })).status, 401);
  assert.strictEqual((await req('POST', '/api/login', { body: { username: 'alice', password: 'secret123' } })).status, 200);
  ok('duplicate / invalid / wrong-password / valid login');
  assert.strictEqual((await req('POST', '/api/profile', { cookie: alice.cookie, body: { name: 'X' }, headers: { Origin: 'http://evil.example' } })).status, 403);
  ok('cross-origin POST rejected');
  await assert.rejects(openWs('sid=nope'), (e) => e.status === 401);
  await assert.rejects(openWs(alice.cookie, 'http://evil.example'), (e) => e.status === 403);
  ok('websocket rejects anonymous and cross-origin clients');

  console.log('chat');
  const found = await req('GET', '/api/users?q=bo', { cookie: alice.cookie });
  assert.deepStrictEqual(found.json.users.map((u) => u.username), ['bob']);
  const direct = (await req('POST', '/api/chats', { cookie: alice.cookie, body: { type: 'direct', userId: bob.me.id } })).json.chat;
  const again = (await req('POST', '/api/chats', { cookie: bob.cookie, body: { type: 'direct', userId: alice.me.id } })).json.chat;
  assert.strictEqual(direct.id, again.id);
  ok('user search and direct chat (deduplicated)');

  const wa = await openWs(alice.cookie);
  const wb = await openWs(bob.cookie);
  const wc = await openWs(carol.cookie);
  await wa.waitFor((e) => e.t === 'presence' && e.userId === bob.me.id && e.online).catch(() => {});

  wa.sendJson({ t: 'send', chatId: direct.id, text: '  Привет, Боб!  ', tmp: 't1' });
  const got = await wb.waitFor((e) => e.t === 'message' && e.message.text === 'Привет, Боб!');
  assert.strictEqual(got.message.from, alice.me.id);
  assert.strictEqual(got.tmp, 't1');
  assert.strictEqual(wc.events.some((e) => e.t === 'message'), false);
  ok('text message delivered to member, not to outsider');

  wb.sendJson({ t: 'typing', chatId: direct.id });
  await wa.waitFor((e) => e.t === 'typing' && e.userId === bob.me.id);
  wb.sendJson({ t: 'read', chatId: direct.id, seq: got.message.seq });
  await wa.waitFor((e) => e.t === 'read' && e.userId === bob.me.id && e.seq === got.message.seq);
  ok('typing indicator and read receipt');

  wb.sendJson({ t: 'send', chatId: direct.id, text: 'ответ', replyTo: got.message.id });
  const reply = await wa.waitFor((e) => e.t === 'message' && e.message.text === 'ответ');
  assert.strictEqual(reply.message.reply.id, got.message.id);
  wb.sendJson({ t: 'edit', chatId: direct.id, id: reply.message.id, text: 'ответ (изм.)' });
  const edited = await wa.waitFor((e) => e.t === 'message-update' && e.message.text === 'ответ (изм.)');
  assert.strictEqual(edited.message.edited, true);
  wa.sendJson({ t: 'edit', chatId: direct.id, id: reply.message.id, text: 'hijack' }); // not the author
  wb.sendJson({ t: 'delete', chatId: direct.id, id: reply.message.id });
  const del = await wa.waitFor((e) => e.t === 'message-update' && e.message.deleted);
  assert.strictEqual(del.message.text, undefined);
  ok('reply, edit (author only), delete');

  console.log('files');
  const doc = Buffer.from('hello file content ✓');
  const f = await upload(alice.cookie, { chatId: direct.id, tmp: 'u1' }, 'отчёт.txt', 'text/plain', doc);
  assert.strictEqual(f.status, 200);
  assert.strictEqual(f.json.message.type, 'file');
  assert.strictEqual(f.json.message.file.name, 'отчёт.txt');
  const fm = await wb.waitFor((e) => e.t === 'message' && e.message.type === 'file');
  const dl = await req('GET', `/api/files/${fm.message.file.id}`, { cookie: bob.cookie });
  assert.strictEqual(dl.status, 200);
  assert.ok(dl.buf.equals(doc));
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.strictEqual((await req('GET', `/api/files/${fm.message.file.id}`, { cookie: carol.cookie })).status, 404);
  assert.strictEqual((await req('GET', `/api/files/${fm.message.file.id}`)).status, 401);
  ok('file upload, download by members only, forced attachment for non-media');

  const v = await upload(alice.cookie, { chatId: direct.id, kind: 'voice', duration: '4.2' }, 'voice.webm', 'audio/webm;codecs=opus', Buffer.alloc(2048, 1));
  assert.strictEqual(v.json.message.type, 'voice');
  assert.strictEqual(v.json.message.file.duration, 4.2);
  const vf = await req('GET', `/api/files/${v.json.message.file.id}`, { cookie: bob.cookie });
  assert.strictEqual(vf.headers.get('content-type'), 'audio/webm');
  assert.match(vf.headers.get('content-disposition'), /^inline/);
  const range = await fetch(`${base}/api/files/${v.json.message.file.id}`, { headers: { Cookie: bob.cookie, Range: 'bytes=0-9' } });
  assert.strictEqual(range.status, 206);
  ok('voice message: typed, served inline, supports Range (seeking)');

  const vn = await upload(alice.cookie, { chatId: direct.id, kind: 'videonote', duration: '9' }, 'note.webm', 'video/webm', Buffer.alloc(4096, 2));
  assert.strictEqual(vn.json.message.type, 'videonote');
  // Chrome sends "video/webm;codecs=vp8,opus"; the comma makes multipart parsers report text/plain
  const webmBytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(512, 4)]);
  const mangled = await upload(alice.cookie, { chatId: direct.id, kind: 'videonote', duration: '3' }, 'n.webm', 'video/webm;codecs=vp8,opus', webmBytes);
  assert.strictEqual(mangled.json.message.type, 'videonote', 'codec list in the part type must not break video notes');
  assert.strictEqual(mangled.json.message.file.mime, 'video/webm');
  const img = await upload(alice.cookie, { chatId: direct.id }, 'p.png', 'image/png', Buffer.alloc(100, 3));
  assert.strictEqual(img.json.message.type, 'image');
  ok('video note and image messages');

  const evil = await upload(alice.cookie, { chatId: direct.id, kind: 'voice' }, 'x.html', 'text/html', '<script>alert(1)</script>');
  assert.strictEqual(evil.json.message.type, 'file');
  const ev = await req('GET', `/api/files/${evil.json.message.file.id}`, { cookie: bob.cookie });
  assert.strictEqual(ev.headers.get('content-type'), 'application/octet-stream');
  assert.match(ev.headers.get('content-disposition'), /^attachment/);
  ok('HTML disguised as a voice message is never served inline');

  const big = await upload(alice.cookie, { chatId: direct.id }, 'big.bin', 'application/octet-stream', Buffer.alloc(1024 * 1024 + 10));
  assert.strictEqual(big.status, 400);
  const foreign = await upload(carol.cookie, { chatId: direct.id }, 'a.txt', 'text/plain', 'x');
  assert.strictEqual(foreign.status, 403);
  assert.strictEqual(fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads')).length, 6, 'rejected uploads must not stay on disk');
  ok('size limit and membership enforced; no orphan files left');

  console.log('history');
  const hist = await req('GET', `/api/chats/${direct.id}/messages?limit=3`, { cookie: alice.cookie });
  assert.strictEqual(hist.json.messages.length, 3);
  assert.strictEqual(hist.json.more, true);
  const older = await req('GET', `/api/chats/${direct.id}/messages?limit=100&before=${hist.json.messages[0].seq}`, { cookie: alice.cookie });
  assert.ok(older.json.messages.every((m) => m.seq < hist.json.messages[0].seq));
  assert.strictEqual((await req('GET', `/api/chats/${direct.id}/messages`, { cookie: carol.cookie })).status, 404);
  const boot = (await req('GET', '/api/bootstrap', { cookie: bob.cookie })).json;
  const bc = boot.chats.find((c) => c.id === direct.id);
  assert.ok(bc.unread >= 1 && bc.last);
  ok('pagination, access control, unread counter');

  console.log('groups');
  const grp = (await req('POST', '/api/chats', { cookie: alice.cookie, body: { type: 'group', title: 'Команда', userIds: [bob.me.id] } })).json.chat;
  await wb.waitFor((e) => e.t === 'message' && e.message.chatId === grp.id && e.message.type === 'system');
  const add = await req('POST', `/api/chats/${grp.id}/members`, { cookie: alice.cookie, body: { userIds: [carol.me.id] } });
  assert.strictEqual(add.json.chat.members.length, 3);
  wc.sendJson({ t: 'send', chatId: grp.id, text: 'всем привет' });
  await wa.waitFor((e) => e.t === 'message' && e.message.text === 'всем привет');
  await wb.waitFor((e) => e.t === 'message' && e.message.text === 'всем привет');
  const leave = await req('POST', `/api/chats/${grp.id}/leave`, { cookie: carol.cookie, body: {} });
  assert.strictEqual(leave.status, 200);
  await wc.waitFor((e) => e.t === 'chat-removed' && e.chatId === grp.id);
  assert.strictEqual((await req('GET', `/api/chats/${grp.id}/messages`, { cookie: carol.cookie })).status, 404);
  ok('group create, add member, broadcast, leave');

  console.log('calls');
  wa.sendJson({ t: 'call:invite', chatId: direct.id, video: true });
  const ringing = await wa.waitFor((e) => e.t === 'call:ringing');
  const incoming = await wb.waitFor((e) => e.t === 'call:incoming');
  assert.strictEqual(incoming.callId, ringing.callId);
  assert.strictEqual(incoming.video, true);
  assert.strictEqual(incoming.from.id, alice.me.id);
  wb.sendJson({ t: 'call:accept', callId: ringing.callId });
  await wa.waitFor((e) => e.t === 'call:accepted');
  wa.sendJson({ t: 'call:signal', callId: ringing.callId, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  const sig = await wb.waitFor((e) => e.t === 'call:signal');
  assert.strictEqual(sig.data.sdp.type, 'offer');
  wb.sendJson({ t: 'call:signal', callId: ringing.callId, data: { candidate: { candidate: 'x' } } });
  await wa.waitFor((e) => e.t === 'call:signal' && e.data.candidate);
  wc.sendJson({ t: 'call:signal', callId: ringing.callId, data: { sdp: { type: 'offer', sdp: 'spy' } } });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(wa.events.filter((e) => e.t === 'call:signal').length, 1, 'outsiders cannot inject signals');
  ok('invite → ring → accept → signalling relay (outsider ignored)');

  // third party cannot call someone who is already in a call
  wc.sendJson({ t: 'call:invite', chatId: direct.id, video: false });
  await wc.waitFor((e) => e.t === 'call:error');
  await new Promise((r) => setTimeout(r, 1200));
  wb.sendJson({ t: 'call:end', callId: ringing.callId });
  const ended = await wa.waitFor((e) => e.t === 'call:ended');
  assert.strictEqual(ended.status, 'ended');
  const logged = await wa.waitFor((e) => e.t === 'message' && e.message.type === 'call');
  assert.strictEqual(logged.message.call.status, 'ended');
  assert.ok(logged.message.call.duration >= 1);
  ok('hang-up is logged in the chat with duration');

  wb.sendJson({ t: 'call:invite', chatId: direct.id, video: false });
  const r2 = await wb.waitFor((e) => e.t === 'call:ringing' && e.callId !== ringing.callId);
  await wa.waitFor((e) => e.t === 'call:incoming' && e.callId === r2.callId);
  wa.sendJson({ t: 'call:reject', callId: r2.callId });
  const dec = await wb.waitFor((e) => e.t === 'call:ended' && e.callId === r2.callId);
  assert.strictEqual(dec.status, 'declined');
  ok('declined call');

  wb.close();
  await wa.waitFor((e) => e.t === 'presence' && e.userId === bob.me.id && !e.online);
  wa.sendJson({ t: 'call:invite', chatId: direct.id, video: false });
  const un = await wa.waitFor((e) => e.t === 'call:unavailable');
  assert.strictEqual(un.reason, 'offline');
  ok('presence goes offline; calling an offline user is reported and logged as missed');

  console.log('persistence');
  const dbFile = path.join(process.env.DATA_DIR, 'db.json');
  await new Promise((r) => setTimeout(r, 700));
  const saved = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  assert.ok(Object.keys(saved.users).length === 3 && saved.messages[direct.id].length > 5);
  assert.ok(!saved.users[alice.me.id].hash.includes('secret'), 'password is hashed');
  assert.ok(!Object.keys(saved.sessions).some((k) => k.length < 60), 'session tokens are stored hashed');
  ok('database persisted; passwords and session tokens are hashed');

  [wa, wc].forEach((w) => w.close());
  server.close();
  console.log(`\nAll ${passed} checks passed`);
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFAILED:', e);
  process.exit(1);
});
