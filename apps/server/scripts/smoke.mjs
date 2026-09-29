// End-to-end smoke test for the auth, channel and messaging layers.
//
// Boots a throwaway server (temp data dir, invite-gated) and exercises the real
// HTTP + WebSocket surface: registration, invites, permissions, login/logout,
// cookies, bearer tokens, gateway IDENTIFY, channel listing, message history
// and realtime fan-out.
//
// Run with: npm run smoke --workspace @harmony/server
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import sharp from 'sharp';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const dataDir = mkdtempSync(join(tmpdir(), 'harmony-smoke-'));

const server = spawn('node', ['src/index.ts'], {
  cwd: serverDir,
  env: {
    ...process.env,
    HARMONY_PORT: String(PORT),
    HARMONY_DATA_DIR: dataDir,
    HARMONY_REQUIRE_INVITE: 'true',
    HARMONY_LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (data) => process.stderr.write(`[server] ${data}`));

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

async function req(path, { method = 'GET', body, cookie, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const setCookie = res.headers.getSetCookie?.()[0] ?? null;

  return {
    status: res.status,
    json: text ? JSON.parse(text) : null,
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

/** Opens a gateway connection, identifies, and returns the events it receives. */
function openGateway(auth = {}) {
  return new Promise((resolveGateway, reject) => {
    const options = auth.cookie ? { headers: { cookie: auth.cookie } } : {};
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`, options);
    const events = [];
    const timer = setTimeout(() => reject(new Error('gateway ready timeout')), 5000);

    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.op === 10) {
        ws.send(JSON.stringify({ op: 2, d: auth.token ? { token: auth.token } : {} }));
        return;
      }
      if (frame.t === 'READY') {
        clearTimeout(timer);
        resolveGateway({ ws, events, ready: frame.d });
        return;
      }
      if (frame.t) events.push(frame);
    });
    ws.on('error', reject);
  });
}

function gatewayIdentify(token) {
  return new Promise((resolveIdentify, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`);
    const result = { ready: null, closeCode: null };
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('gateway timeout'));
    }, 5000);

    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.op === 10) ws.send(JSON.stringify({ op: 2, d: { token } }));
      if (frame.t === 'READY') {
        result.ready = frame.d;
        ws.close();
      }
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      result.closeCode = code;
      resolveIdentify(result);
    });
    ws.on('error', reject);
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('server did not start in time');
}

try {
  await waitForServer();

  // --- Auth ---
  const owner = await req('/auth/register', {
    method: 'POST',
    body: { username: 'alice', password: 'correct horse' },
  });
  check('first user registers', owner.status === 200, `status ${owner.status}`);
  check('first user is owner', owner.json?.user?.isOwner === true);
  check('register sets a session cookie', owner.cookie?.startsWith('harmony_session=') === true);

  const ownerToken = owner.json?.token;
  const me = await req('/auth/me', { cookie: owner.cookie });
  check('cookie authenticates /auth/me', me.status === 200 && me.json?.user?.username === 'alice');
  check('bearer token authenticates /auth/me', (await req('/auth/me', { token: ownerToken })).status === 200);
  check('owner has Administrator', (BigInt(me.json?.permissions ?? '0') & (1n << 14n)) !== 0n);

  const dup = await req('/auth/register', { method: 'POST', body: { username: 'alice', password: 'another one' } });
  check('duplicate username rejected (409)', dup.status === 409, `status ${dup.status}`);

  const invite = await req('/invites', { method: 'POST', token: ownerToken, body: {} });
  check('owner creates an invite', invite.status === 200 && typeof invite.json?.code === 'string');

  const noInvite = await req('/auth/register', { method: 'POST', body: { username: 'bob', password: 'hunter2hunter2' } });
  check('registration without invite rejected (403)', noInvite.status === 403, `status ${noInvite.status}`);

  const badInvite = await req('/auth/register', {
    method: 'POST',
    body: { username: 'bob', password: 'hunter2hunter2', inviteCode: 'nope' },
  });
  check('registration with invalid invite rejected (403)', badInvite.status === 403, `status ${badInvite.status}`);

  const bob = await req('/auth/register', {
    method: 'POST',
    body: { username: 'bob', password: 'hunter2hunter2', inviteCode: invite.json?.code },
  });
  check('registration with valid invite succeeds', bob.status === 200, `status ${bob.status}`);
  check('second user is not owner', bob.json?.user?.isOwner === false);

  const bobToken = bob.json?.token;
  const bobMe = await req('/auth/me', { token: bobToken });
  check('member lacks Administrator', (BigInt(bobMe.json?.permissions ?? '0') & (1n << 14n)) === 0n);
  check('member cannot list invites (403)', (await req('/invites', { token: bobToken })).status === 403);

  const wrongPassword = await req('/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong' } });
  check('wrong password rejected (401)', wrongPassword.status === 401, `status ${wrongPassword.status}`);

  const login = await req('/auth/login', { method: 'POST', body: { username: 'alice', password: 'correct horse' } });
  check('correct password logs in', login.status === 200 && typeof login.json?.token === 'string');

  const gatewayOk = await gatewayIdentify(login.json?.token);
  check('gateway IDENTIFY with valid token yields READY', gatewayOk.ready?.user?.username === 'alice');

  const gatewayBad = await gatewayIdentify('not-a-real-token');
  check('gateway IDENTIFY with bad token closes 4004', gatewayBad.closeCode === 4004, `code ${gatewayBad.closeCode}`);

  // --- Channels, categories and messages ---
  const channelList = await req('/channels', { token: ownerToken });
  const general = channelList.json?.channels?.find((channel) => channel.name === 'general');
  check('channel list loads', channelList.status === 200, `status ${channelList.status}`);
  check(
    'seeded category "Text Channels" exists',
    channelList.json?.categories?.some((category) => category.name === 'Text Channels') === true,
  );
  check('seeded channel "general" exists', Boolean(general));

  if (general) {
    const emptyHistory = await req(`/channels/${general.id}/messages`, { token: ownerToken });
    check('message history starts empty', emptyHistory.json?.messages?.length === 0);

    const cookieGateway = await openGateway({ cookie: owner.cookie });
    check('gateway identifies via session cookie', cookieGateway.ready?.user?.username === 'alice');
    cookieGateway.ws.close();

    const posted = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'hello world' },
    });
    check('message is created', posted.status === 200 && posted.json?.content === 'hello world');
    const messageId = posted.json?.id;

    const history = await req(`/channels/${general.id}/messages`, { token: ownerToken });
    check('message appears in history', history.json?.messages?.some((m) => m.id === messageId) === true);

    const fanout = await openGateway({ token: ownerToken });
    await req(`/channels/${general.id}/messages`, { method: 'POST', token: ownerToken, body: { content: 'broadcast me' } });
    await sleep(250);
    check(
      'gateway broadcasts MESSAGE_CREATE',
      fanout.events.some((event) => event.t === 'MESSAGE_CREATE' && event.d?.content === 'broadcast me'),
    );
    fanout.ws.close();

    const edited = await req(`/messages/${messageId}`, {
      method: 'PATCH',
      token: ownerToken,
      body: { content: 'edited' },
    });
    check('author can edit their message', edited.json?.content === 'edited' && edited.json?.editedAt != null);
    check(
      "member cannot edit another user's message (403)",
      (await req(`/messages/${messageId}`, { method: 'PATCH', token: bobToken, body: { content: 'nope' } })).status === 403,
    );
    check(
      'member cannot create channels (403)',
      (await req('/channels', { method: 'POST', token: bobToken, body: { name: 'secret' } })).status === 403,
    );

    check('author can delete their message', (await req(`/messages/${messageId}`, { method: 'DELETE', token: ownerToken })).status === 204);
    const afterDelete = await req(`/channels/${general.id}/messages`, { token: ownerToken });
    check('deleted message is gone from history', afterDelete.json?.messages?.some((m) => m.id === messageId) === false);

    // --- Images ---
    const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 30, g: 120, b: 200 } } })
      .png()
      .toBuffer();

    const uploadForm = new FormData();
    uploadForm.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
    const uploadRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: uploadForm,
    });
    const uploaded = await uploadRes.json();
    check('image uploads', uploadRes.status === 200 && uploaded?.contentType === 'image/png', `status ${uploadRes.status}`);
    check('image dimensions are recorded', uploaded?.width === 12 && uploaded?.height === 8);
    const attachmentId = uploaded?.id;

    const withImage = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'look at this', attachmentIds: [attachmentId] },
    });
    check('message carries its attachment', withImage.json?.attachments?.length === 1);

    const reuse = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { attachmentIds: [attachmentId] },
    });
    check('an attachment cannot be reused (400)', reuse.status === 400, `status ${reuse.status}`);

    const served = await fetch(`${BASE}/attachments/${attachmentId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const servedBytes = Buffer.from(await served.arrayBuffer());
    check(
      'uploaded image is served back byte-for-byte',
      served.status === 200 && served.headers.get('content-type') === 'image/png' && servedBytes.equals(png),
      `status ${served.status}`,
    );
    check('attachments require auth (401)', (await fetch(`${BASE}/attachments/${attachmentId}`)).status === 401);

    const badType = new FormData();
    badType.append('file', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'notes.txt');
    const badRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: badType,
    });
    check('non-image upload rejected (415)', badRes.status === 415, `status ${badRes.status}`);

    const fakeImage = new FormData();
    fakeImage.append('file', new Blob([Buffer.from('definitely not a png')], { type: 'image/png' }), 'fake.png');
    const fakeRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: fakeImage,
    });
    check('unreadable image rejected (415)', fakeRes.status === 415, `status ${fakeRes.status}`);
  }

  check('logout succeeds', (await req('/auth/logout', { method: 'POST', cookie: login.cookie })).status === 200);
  check('session is dead after logout (401)', (await req('/auth/me', { cookie: login.cookie })).status === 401);
} catch (error) {
  failures++;
  console.error('UNEXPECTED ERROR:', error);
} finally {
  server.kill('SIGTERM');
  await sleep(200);
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
