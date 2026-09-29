// End-to-end smoke test for the auth, channel and messaging layers.
//
// Boots a throwaway server (temp data dir, invite-gated) and exercises the real
// HTTP + WebSocket surface: registration, invites, permissions, login/logout,
// cookies, bearer tokens, gateway IDENTIFY, channel listing, message history
// and realtime fan-out.
//
// Run with: npm run smoke --workspace @harmony/server
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
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

  // --- Admin: settings, roles, members, invites ---
  const metaRes = await req('/meta');
  check('public meta is available', metaRes.status === 200 && typeof metaRes.json?.name === 'string');
  check('meta reports requireInvite', metaRes.json?.requireInvite === true);

  const settings = await req('/settings', { token: ownerToken });
  check('owner reads settings', settings.status === 200 && settings.json?.serverName === 'Harmony');

  const patched = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { serverName: 'Test Server' },
  });
  check('owner updates settings', patched.json?.serverName === 'Test Server');
  check('meta reflects the new name', (await req('/meta')).json?.name === 'Test Server');
  check('member cannot read settings (403)', (await req('/settings', { token: bobToken })).status === 403);

  // Toggling requireInvite in settings takes effect immediately.
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { requireInvite: false } });
  const openReg = await req('/auth/register', {
    method: 'POST',
    body: { username: 'carol', password: 'carol-password' },
  });
  check('registration opens when requireInvite is false', openReg.status === 200, `status ${openReg.status}`);
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { requireInvite: true } });

  const rolesRes = await req('/roles', { token: ownerToken });
  const everyoneRole = rolesRes.json?.roles?.find((role) => role.isDefault);
  check('roles list includes @everyone', Boolean(everyoneRole));

  const newRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Moderator' } });
  check('owner creates a role', newRole.status === 200 && newRole.json?.name === 'Moderator');
  const roleId = newRole.json?.id;

  const manageMessages = String(1n << 2n);
  const granted = await req(`/roles/${roleId}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { permissions: manageMessages },
  });
  check('role permissions update', granted.json?.permissions === manageMessages);

  check(
    '@everyone cannot be renamed (403)',
    (await req(`/roles/${everyoneRole.id}`, { method: 'PATCH', token: ownerToken, body: { name: 'nope' } })).status === 403,
  );
  check(
    '@everyone cannot be deleted (403)',
    (await req(`/roles/${everyoneRole.id}`, { method: 'DELETE', token: ownerToken })).status === 403,
  );
  check(
    'member cannot create roles (403)',
    (await req('/roles', { method: 'POST', token: bobToken, body: { name: 'hax' } })).status === 403,
  );

  const membersRes = await req('/members', { token: ownerToken });
  check('owner lists members', membersRes.status === 200 && membersRes.json?.members?.length >= 3);
  check('member cannot list members (403)', (await req('/members', { token: bobToken })).status === 403);

  const bobId = bob.json?.user?.id;
  check(
    'owner assigns a role',
    (await req(`/members/${bobId}/roles/${roleId}`, { method: 'PUT', token: ownerToken })).status === 204,
  );
  const bobAfter = await req('/auth/me', { token: bobToken });
  check('assigned role grants permissions', (BigInt(bobAfter.json?.permissions ?? '0') & (1n << 2n)) !== 0n);

  check(
    'owner removes a role',
    (await req(`/members/${bobId}/roles/${roleId}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  const bobCleared = await req('/auth/me', { token: bobToken });
  check('removing a role takes permissions away', (BigInt(bobCleared.json?.permissions ?? '0') & (1n << 2n)) === 0n);

  check(
    'the default role cannot be assigned (400)',
    (await req(`/members/${bobId}/roles/${everyoneRole.id}`, { method: 'PUT', token: ownerToken })).status === 400,
  );

  const revokeTarget = await req('/invites', { method: 'POST', token: ownerToken, body: {} });
  check(
    'owner revokes an invite',
    (await req(`/invites/${revokeTarget.json?.code}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );

  check(
    'owner deletes a role',
    (await req(`/roles/${roleId}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );

  // --- Username colours and role ordering ---
  const red = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Red', color: 0xff0000 } });
  const blue = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Blue', color: 0x0000ff } });
  check('roles accept colours', red.json?.color === 0xff0000 && blue.json?.color === 0x0000ff);

  await req(`/members/${bobId}/roles/${red.json?.id}`, { method: 'PUT', token: ownerToken });
  await req(`/members/${bobId}/roles/${blue.json?.id}`, { method: 'PUT', token: ownerToken });

  const bobColoured = await req('/auth/me', { token: bobToken });
  check(
    'the highest-positioned role decides the colour',
    bobColoured.json?.user?.roleColor === 0x0000ff,
    `got ${bobColoured.json?.user?.roleColor}`,
  );

  const reordered = await req(`/roles/${red.json?.id}/move`, {
    method: 'POST',
    token: ownerToken,
    body: { direction: 'up' },
  });
  check('moving a role reorders it', reordered.json?.roles?.[0]?.id === red.json?.id);

  const bobAfterMove = await req('/auth/me', { token: bobToken });
  check(
    'the colour follows the new order',
    bobAfterMove.json?.user?.roleColor === 0xff0000,
    `got ${bobAfterMove.json?.user?.roleColor}`,
  );

  check(
    '@everyone cannot be reordered (403)',
    (
      await req(`/roles/${everyoneRole.id}/move`, { method: 'POST', token: ownerToken, body: { direction: 'up' } })
    ).status === 403,
  );

  const colourChannel = (await req('/channels', { token: bobToken })).json?.channels?.find(
    (channel) => channel.name === 'general',
  );
  const colourMessage = await req(`/channels/${colourChannel.id}/messages`, {
    method: 'POST',
    token: bobToken,
    body: { content: 'colour check' },
  });
  check(
    'message authors carry their role colour',
    colourMessage.json?.author?.roleColor === 0xff0000,
    `got ${colourMessage.json?.author?.roleColor}`,
  );

  // --- Custom emoji ---
  const emojiPng = await sharp({
    create: { width: 24, height: 24, channels: 4, background: { r: 255, g: 200, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();

  const emojiForm = new FormData();
  emojiForm.append('name', 'party');
  emojiForm.append('file', new Blob([emojiPng], { type: 'image/png' }), 'party.png');
  const emojiUpload = await fetch(`${BASE}/emojis`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: emojiForm,
  });
  const emoji = await emojiUpload.json();
  check('emoji uploads', emojiUpload.status === 200 && emoji?.name === 'party', `status ${emojiUpload.status}`);
  check('static emoji is not marked animated', emoji?.animated === false);

  const duplicateEmoji = new FormData();
  duplicateEmoji.append('name', 'party');
  duplicateEmoji.append('file', new Blob([emojiPng], { type: 'image/png' }), 'party.png');
  check(
    'duplicate emoji name rejected (409)',
    (
      await fetch(`${BASE}/emojis`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: duplicateEmoji,
      })
    ).status === 409,
  );

  const shortName = new FormData();
  shortName.append('name', 'x');
  shortName.append('file', new Blob([emojiPng], { type: 'image/png' }), 'x.png');
  check(
    'invalid emoji name rejected (400)',
    (
      await fetch(`${BASE}/emojis`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: shortName,
      })
    ).status === 400,
  );

  const notAnEmoji = new FormData();
  notAnEmoji.append('name', 'nope');
  notAnEmoji.append('file', new Blob([Buffer.from('plain text')], { type: 'text/plain' }), 'n.txt');
  check(
    'non-image emoji rejected (415)',
    (
      await fetch(`${BASE}/emojis`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: notAnEmoji,
      })
    ).status === 415,
  );

  const emojiList = await req('/emojis', { token: bobToken });
  check(
    'members can list emoji',
    emojiList.status === 200 && emojiList.json?.emojis?.some((entry) => entry.name === 'party') === true,
  );

  const servedEmoji = await fetch(`${BASE}/emojis/${emoji.id}`, {
    headers: { authorization: `Bearer ${bobToken}` },
  });
  const servedEmojiBytes = Buffer.from(await servedEmoji.arrayBuffer());
  check(
    'emoji image is served back',
    servedEmoji.status === 200 &&
      servedEmoji.headers.get('content-type') === 'image/png' &&
      servedEmojiBytes.equals(emojiPng),
  );
  check('emoji images require auth (401)', (await fetch(`${BASE}/emojis/${emoji.id}`)).status === 401);

  const bobEmoji = new FormData();
  bobEmoji.append('name', 'bobemoji');
  bobEmoji.append('file', new Blob([emojiPng], { type: 'image/png' }), 'b.png');
  check(
    'member cannot upload emoji (403)',
    (
      await fetch(`${BASE}/emojis`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bobToken}` },
        body: bobEmoji,
      })
    ).status === 403,
  );
  check(
    'member cannot delete emoji (403)',
    (await req(`/emojis/${emoji.id}`, { method: 'DELETE', token: bobToken })).status === 403,
  );
  check(
    'owner deletes emoji',
    (await req(`/emojis/${emoji.id}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'deleted emoji is gone',
    (await req('/emojis', { token: ownerToken })).json?.emojis?.every((entry) => entry.name !== 'party') === true,
  );

  // --- Retention and pruning ---
  const retention = await req('/retention', { token: ownerToken });
  check(
    'owner reads retention settings',
    retention.status === 200 && retention.json?.settings?.imageRetentionDays === null,
  );
  check('retention reports usage', typeof retention.json?.usage?.blobBytes === 'number');
  check('member cannot read retention (403)', (await req('/retention', { token: bobToken })).status === 403);

  // The emoji was deleted earlier, so its blob is now orphaned on disk.
  const emojiBlobPath = join(dataDir, 'uploads', emoji.hash.slice(0, 2), emoji.hash);
  check('deleted emoji leaves an orphaned blob on disk', existsSync(emojiBlobPath));

  // Emergency pruning: a 1-byte limit forces everything out.
  const pruneUpload = new FormData();
  pruneUpload.append('file', new Blob([emojiPng], { type: 'image/png' }), 'prune.png');
  const pruneAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: pruneUpload,
    })
  ).json();
  await req(`/channels/${colourChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'will be pruned', attachmentIds: [pruneAttachment.id] },
  });
  const pruneBlobPath = join(dataDir, 'uploads', pruneAttachment.hash.slice(0, 2), pruneAttachment.hash);
  check('attachment blob exists before pruning', existsSync(pruneBlobPath));

  await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { storageLimitBytes: 1, storageTargetBytes: 0 },
  });
  const emergency = await req('/retention/run', { method: 'POST', token: ownerToken });
  check(
    'emergency pruning deletes attachments',
    emergency.json?.summary?.deletedAttachments > 0,
    JSON.stringify(emergency.json?.summary),
  );
  check(
    'emergency pruning empties stored media',
    emergency.json?.usage?.blobBytes === 0,
    `bytes ${emergency.json?.usage?.blobBytes}`,
  );
  check('pruned attachment blob is removed', !existsSync(pruneBlobPath));
  check('orphaned emoji blob is swept', !existsSync(emojiBlobPath));

  await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { storageLimitBytes: null, storageTargetBytes: null },
  });

  // Age-based image retention.
  const ageUpload = new FormData();
  ageUpload.append('file', new Blob([emojiPng], { type: 'image/png' }), 'age.png');
  const ageAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: ageUpload,
    })
  ).json();
  await req(`/channels/${colourChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'aged image', attachmentIds: [ageAttachment.id] },
  });

  await req('/retention', { method: 'PATCH', token: ownerToken, body: { imageRetentionDays: 0 } });
  const aged = await req('/retention/run', { method: 'POST', token: ownerToken });
  check('image retention deletes old attachments', aged.json?.summary?.deletedAttachments > 0);
  check(
    'expired attachment is no longer served (404)',
    (
      await fetch(`${BASE}/attachments/${ageAttachment.id}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).status === 404,
  );

  // Age-based message retention.
  await req(`/channels/${colourChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'aged text' },
  });
  await req('/retention', { method: 'PATCH', token: ownerToken, body: { messageRetentionDays: 0 } });
  const msgPruned = await req('/retention/run', { method: 'POST', token: ownerToken });
  check('message retention deletes old messages', msgPruned.json?.summary?.deletedMessages > 0);
  check(
    'channel is empty after message retention',
    (await req(`/channels/${colourChannel.id}/messages`, { token: ownerToken })).json?.messages?.length === 0,
  );

  // --- Profile: display name and picture ---
  const renamed = await req('/users/@me', {
    method: 'PATCH',
    token: ownerToken,
    body: { displayName: 'Alice the Great' },
  });
  check('display name is saved', renamed.status === 200 && renamed.json?.user?.displayName === 'Alice the Great');
  check(
    'display name is returned by /auth/me',
    (await req('/auth/me', { token: ownerToken })).json?.user?.displayName === 'Alice the Great',
  );

  const named = await req(`/channels/${colourChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'named hello' },
  });
  check('messages carry the display name', named.json?.author?.displayName === 'Alice the Great');

  const avatarPng = await sharp({ create: { width: 64, height: 40, channels: 3, background: { r: 200, g: 40, b: 90 } } })
    .png()
    .toBuffer();
  const avatarForm = new FormData();
  avatarForm.append('file', new Blob([avatarPng], { type: 'image/png' }), 'me.png');
  const avatarRes = await fetch(`${BASE}/users/@me/avatar`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: avatarForm,
  });
  const avatarUser = await avatarRes.json();
  const avatarHash = avatarUser?.user?.avatarHash;
  check(
    'avatar uploads',
    avatarRes.status === 200 && typeof avatarHash === 'string',
    `status ${avatarRes.status}`,
  );

  const avatarServed = await fetch(`${BASE}/users/${avatarUser.user.id}/avatar`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const avatarBytes = Buffer.from(await avatarServed.arrayBuffer());
  check(
    'avatar is served as webp',
    avatarServed.status === 200 && avatarServed.headers.get('content-type') === 'image/webp' && avatarBytes.length > 0,
  );
  check(
    'avatars require auth (401)',
    (await fetch(`${BASE}/users/${avatarUser.user.id}/avatar`)).status === 401,
  );

  const notAnAvatar = new FormData();
  notAnAvatar.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'n.txt');
  check(
    'non-image avatar rejected (415)',
    (
      await fetch(`${BASE}/users/@me/avatar`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: notAnAvatar,
      })
    ).status === 415,
  );

  // An avatar is a referenced blob, so pruning must not sweep it away.
  const avatarBlobPath = join(dataDir, 'uploads', avatarHash.slice(0, 2), avatarHash);
  check('avatar blob exists before pruning', existsSync(avatarBlobPath));
  await req('/retention/run', { method: 'POST', token: ownerToken });
  check('avatar blob survives pruning', existsSync(avatarBlobPath));
  check(
    'avatar is still served after pruning',
    (
      await fetch(`${BASE}/users/${avatarUser.user.id}/avatar`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).status === 200,
  );

  check(
    'avatar can be removed',
    (await req('/users/@me/avatar', { method: 'DELETE', token: ownerToken })).json?.user?.avatarHash === null,
  );
  check(
    'removed avatar 404s',
    (
      await fetch(`${BASE}/users/${avatarUser.user.id}/avatar`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).status === 404,
  );

  check(
    'display name can be cleared',
    (await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { displayName: null } })).json?.user
      ?.displayName === null,
  );

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
