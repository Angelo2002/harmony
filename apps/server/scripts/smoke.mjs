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
import { listEmbeddableUrls, deriveTheme, relativeLuminance, DEFAULT_ACCENT, DEFAULT_BACKGROUND } from '@harmony/shared';
import { isPrivateAddress, parseEmbedMetadata } from '../src/embeds/metadata.ts';

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

/** A minimal well-formed MP4 header: a size word, then the required ftyp box. */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isomiso2'),
  Buffer.alloc(64),
]);

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
  check('a real member carries no Discord id', me.json?.user?.discordId === null);
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

    // --- Replies ---
    const parent = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'parent message' },
    });
    const reply = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'a reply', replyToId: parent.json?.id },
    });
    check('a reply records its parent', reply.json?.replyTo?.id === parent.json?.id);
    check('the reply preview carries the parent text', reply.json?.replyTo?.content === 'parent message');
    check(
      'replying to a missing message is rejected (400)',
      (
        await req(`/channels/${general.id}/messages`, {
          method: 'POST',
          token: ownerToken,
          body: { content: 'x', replyToId: 'does-not-exist' },
        })
      ).status === 400,
    );

    // --- Reactions ---
    const reactTarget = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: ownerToken,
      body: { content: 'react target' },
    });
    const reacted = await req(`/messages/${reactTarget.json?.id}/reactions`, {
      method: 'POST',
      token: ownerToken,
      body: { emoji: '👍' },
    });
    check(
      'a reaction is added',
      reacted.json?.reactions?.some((r) => r.emoji === '👍' && r.count === 1 && r.me === true) === true,
    );
    const unreacted = await req(`/messages/${reactTarget.json?.id}/reactions`, {
      method: 'POST',
      token: ownerToken,
      body: { emoji: '👍' },
    });
    check('reacting again toggles the reaction off', unreacted.json?.reactions?.length === 0);

    await req(`/messages/${reactTarget.json?.id}/reactions`, {
      method: 'POST',
      token: bobToken,
      body: { emoji: '🎉' },
    });
    const seenByOwner = await req(`/channels/${general.id}/messages`, { token: ownerToken });
    const seenMessage = seenByOwner.json?.messages?.find((m) => m.id === reactTarget.json?.id);
    check(
      "another user's reaction is visible but not 'me'",
      seenMessage?.reactions?.some((r) => r.emoji === '🎉' && r.me === false) === true,
    );
    check(
      'member cannot clear reactions (403)',
      (await req(`/messages/${reactTarget.json?.id}/reactions?emoji=${encodeURIComponent('🎉')}`, {
        method: 'DELETE',
        token: bobToken,
      })).status === 403,
    );
    check(
      'owner can clear reactions',
      (await req(`/messages/${reactTarget.json?.id}/reactions?emoji=${encodeURIComponent('🎉')}`, {
        method: 'DELETE',
        token: ownerToken,
      })).json?.reactions?.length === 0,
    );

    // --- Pagination ---
    await req(`/channels/${general.id}/messages`, { method: 'POST', token: ownerToken, body: { content: 'page one' } });
    await req(`/channels/${general.id}/messages`, { method: 'POST', token: ownerToken, body: { content: 'page two' } });
    await req(`/channels/${general.id}/messages`, { method: 'POST', token: ownerToken, body: { content: 'page three' } });

    const newestPage = await req(`/channels/${general.id}/messages?limit=2`, { token: ownerToken });
    const boundary = newestPage.json?.messages?.[0];
    check(
      'history pages from the newest message',
      newestPage.json?.messages?.length === 2 && newestPage.json?.messages?.at(-1)?.content === 'page three',
    );
    const olderPage = await req(
      `/channels/${general.id}/messages?limit=2&before=${encodeURIComponent(boundary?.createdAt)}&beforeId=${boundary?.id}`,
      { token: ownerToken },
    );
    check(
      'the cursor returns the messages before it',
      olderPage.json?.messages?.some((message) => message.content === 'page one') === true,
    );
    check(
      'the cursor does not repeat its own message',
      olderPage.json?.messages?.every((message) => message.id !== boundary?.id) === true,
    );

    // Admins may delete another user's message, but like Discord, never edit it.
    const bobMessage = await req(`/channels/${general.id}/messages`, {
      method: 'POST',
      token: bobToken,
      body: { content: 'bob says hi' },
    });
    check(
      "even an admin cannot edit another user's message (403)",
      (await req(`/messages/${bobMessage.json?.id}`, {
        method: 'PATCH',
        token: ownerToken,
        body: { content: 'rewritten' },
      })).status === 403,
    );
    check(
      "an admin can delete another user's message",
      (await req(`/messages/${bobMessage.json?.id}`, { method: 'DELETE', token: ownerToken })).status === 204,
    );

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

    // --- Videos ---
    const videoForm = new FormData();
    videoForm.append('file', new Blob([MP4], { type: 'video/mp4' }), 'clip.mp4');
    const videoRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: videoForm,
    });
    const clip = await videoRes.json();
    check(
      'an mp4 uploads',
      videoRes.status === 200 && clip?.contentType === 'video/mp4',
      `status ${videoRes.status}`,
    );
    check('a clip records no dimensions', clip?.width === null && clip?.height === null);

    const ranged = await fetch(`${BASE}/attachments/${clip.id}`, {
      headers: { authorization: `Bearer ${ownerToken}`, range: 'bytes=0-3' },
    });
    const rangedBytes = Buffer.from(await ranged.arrayBuffer());
    check(
      'a range request returns just that slice',
      ranged.status === 206 &&
        ranged.headers.get('content-range') === `bytes 0-3/${MP4.length}` &&
        rangedBytes.equals(MP4.subarray(0, 4)),
      `status ${ranged.status} ${ranged.headers.get('content-range')}`,
    );
    check('clips advertise range support', ranged.headers.get('accept-ranges') === 'bytes');

    const fakeVideo = new FormData();
    fakeVideo.append('file', new Blob([Buffer.from('definitely not an mp4')], { type: 'video/mp4' }), 'fake.mp4');
    const fakeVideoRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: fakeVideo,
    });
    check('unreadable video rejected (415)', fakeVideoRes.status === 415, `status ${fakeVideoRes.status}`);

    await req('/settings', { method: 'PATCH', token: ownerToken, body: { maxVideoBytes: 1024 } });
    const bigClip = new FormData();
    bigClip.append('file', new Blob([Buffer.concat([MP4, Buffer.alloc(4096)])], { type: 'video/mp4' }), 'big.mp4');
    const bigClipRes = await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: bigClip,
    });
    check('an oversized clip is rejected (413)', bigClipRes.status === 413, `status ${bigClipRes.status}`);
    await req('/settings', { method: 'PATCH', token: ownerToken, body: { maxVideoBytes: 20 * 1024 * 1024 } });
  }

  // --- Admin: settings, roles, members, invites ---
  const metaRes = await req('/meta');
  check('public meta is available', metaRes.status === 200 && typeof metaRes.json?.name === 'string');
  check('meta reports requireInvite', metaRes.json?.requireInvite === true);
  check('meta reports the upload limits', metaRes.json?.maxImageBytes > 0 && metaRes.json?.maxVideoBytes > 0);
  check('meta lists mp4 as a video type', metaRes.json?.allowedVideoTypes?.includes('video/mp4') === true);

  const settings = await req('/settings', { token: ownerToken });
  check('owner reads settings', settings.status === 200 && settings.json?.serverName === 'Harmony');
  check('settings start with no default channel', settings.json?.defaultChannelId === null);
  check('link previews default to on', settings.json?.embedsEnabled === true);
  check('settings report the upload limits', settings.json?.maxImageBytes > 0 && settings.json?.maxVideoBytes > 0);

  const resized = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { maxImageBytes: 3 * 1024 * 1024, maxVideoBytes: 25 * 1024 * 1024 },
  });
  check(
    'the upload limits can be changed',
    resized.json?.maxImageBytes === 3 * 1024 * 1024 && resized.json?.maxVideoBytes === 25 * 1024 * 1024,
  );
  check('meta follows the upload limits', (await req('/meta')).json?.maxVideoBytes === 25 * 1024 * 1024);
  await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { maxImageBytes: 10 * 1024 * 1024, maxVideoBytes: 20 * 1024 * 1024 },
  });

  const embedsOff = await req('/settings', { method: 'PATCH', token: ownerToken, body: { embedsEnabled: false } });
  check('link previews can be turned off', embedsOff.json?.embedsEnabled === false);
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { embedsEnabled: true } });

  check('the instance starts on the built-in colours', settings.json?.theme?.background === null && settings.json?.theme?.accent === null);
  const themed = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { theme: { background: '#101018', accent: '#ff8800' } },
  });
  check(
    'owner sets the instance colours',
    themed.json?.theme?.background === '#101018' && themed.json?.theme?.accent === '#ff8800',
  );
  check('public meta carries the colours', (await req('/meta')).json?.theme?.accent === '#ff8800');

  const badTheme = await req('/settings', { method: 'PATCH', token: ownerToken, body: { theme: { background: 'red' } } });
  check('a colour that is not #rrggbb is rejected (400)', badTheme.status === 400, `status ${badTheme.status}`);
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { theme: { background: null, accent: null } } });

  // The default channel lives in settings and is echoed with the channel list so
  // clients can open it on load.
  const setDefault = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { defaultChannelId: general.id },
  });
  check('owner sets the default channel', setDefault.json?.defaultChannelId === general.id);
  check(
    'channel list reports the default channel',
    (await req('/channels', { token: ownerToken })).json?.defaultChannelId === general.id,
  );

  const badDefault = await req('/settings', {
    method: 'PATCH',
    token: ownerToken,
    body: { defaultChannelId: 'no-such-channel' },
  });
  check('a default channel must exist (400)', badDefault.status === 400, `status ${badDefault.status}`);

  // Deleting the default channel clears the preference instead of leaving it dangling.
  const tempChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'temp-default' },
  });
  await req('/settings', { method: 'PATCH', token: ownerToken, body: { defaultChannelId: tempChannel.json.id } });
  await req(`/channels/${tempChannel.json.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'deleting the default channel clears the preference',
    (await req('/settings', { token: ownerToken })).json?.defaultChannelId === null,
  );

  // A category that still holds channels cannot be deleted, so nothing is orphaned.
  const busyCategory = await req('/categories', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'busy-category' },
  });
  const busyChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'busy-channel', categoryId: busyCategory.json.id },
  });
  const refusedCategory = await req(`/categories/${busyCategory.json.id}`, {
    method: 'DELETE',
    token: ownerToken,
  });
  check(
    'a non-empty category cannot be deleted (409)',
    refusedCategory.status === 409 && refusedCategory.json?.error?.code === 'category_not_empty',
    `status ${refusedCategory.status}`,
  );

  // Emptying it out allows the delete.
  await req(`/channels/${busyChannel.json.id}`, { method: 'DELETE', token: ownerToken });
  const emptiedCategory = await req(`/categories/${busyCategory.json.id}`, {
    method: 'DELETE',
    token: ownerToken,
  });
  check('an empty category can be deleted', emptiedCategory.status === 204, `status ${emptiedCategory.status}`);

  // --- Reordering and recategorising channels ---
  async function channelNamesIn(categoryId) {
    const res = await req('/channels', { token: ownerToken });
    return res.json.channels.filter((channel) => channel.categoryId === categoryId).map((channel) => channel.name);
  }

  const textCategory = (await req('/channels', { token: ownerToken })).json.categories.find(
    (category) => category.name === 'Text Channels',
  );
  const alpha = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'alpha', categoryId: textCategory.id },
  });
  const bravo = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'bravo', categoryId: textCategory.id },
  });

  const appended = await channelNamesIn(textCategory.id);
  check(
    'new channels append to the end of their category',
    appended.at(-2) === 'alpha' && appended.at(-1) === 'bravo',
    appended.join(', '),
  );

  await req(`/channels/${bravo.json.id}/move`, { method: 'POST', token: ownerToken, body: { direction: 'up' } });
  check(
    'moving a channel up swaps it with its neighbour',
    JSON.stringify((await channelNamesIn(textCategory.id)).slice(-2)) === JSON.stringify(['bravo', 'alpha']),
  );

  // The channel at the top of the category cannot move any higher.
  const topChannel = (await req('/channels', { token: ownerToken })).json.channels.filter(
    (channel) => channel.categoryId === textCategory.id,
  )[0];
  const noopBefore = await channelNamesIn(textCategory.id);
  await req(`/channels/${topChannel.id}/move`, { method: 'POST', token: ownerToken, body: { direction: 'up' } });
  check(
    'moving the first channel up does nothing',
    JSON.stringify(await channelNamesIn(textCategory.id)) === JSON.stringify(noopBefore),
  );

  // Recategorising moves the channel, and it lands at the end of its new home.
  const miscCategory = await req('/categories', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Misc' },
  });
  await req(`/channels/${alpha.json.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { categoryId: miscCategory.json.id },
  });
  check(
    'recategorising moves the channel into the target category',
    JSON.stringify(await channelNamesIn(miscCategory.json.id)) === JSON.stringify(['alpha']),
  );
  check(
    'recategorising removes the channel from its old category',
    !(await channelNamesIn(textCategory.id)).includes('alpha'),
  );

  // Category reordering swaps with the neighbour, and is a no-op at the top.
  const catsBefore = (await req('/channels', { token: ownerToken })).json.categories.map((topic) => topic.name);
  await req(`/categories/${miscCategory.json.id}/move`, { method: 'POST', token: ownerToken, body: { direction: 'up' } });
  const catsAfter = (await req('/channels', { token: ownerToken })).json.categories.map((topic) => topic.name);
  check(
    'moving a category up reorders the sidebar',
    catsAfter.indexOf('Misc') === catsBefore.indexOf('Misc') - 1,
    catsAfter.join(', '),
  );

  const topCategory = (await req('/channels', { token: ownerToken })).json.categories[0];
  await req(`/categories/${topCategory.id}/move`, { method: 'POST', token: ownerToken, body: { direction: 'up' } });
  check(
    'moving the first category up does nothing',
    (await req('/channels', { token: ownerToken })).json.categories[0]?.id === topCategory.id,
  );

  // Clean up so later tests see the original channel tree.
  await req(`/channels/${alpha.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/channels/${bravo.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/categories/${miscCategory.json.id}`, { method: 'DELETE', token: ownerToken });

  // --- Typing indicators ---
  check('typing indicators default to on', owner.json?.user?.showTyping === true);
  const typingPing = await req(`/channels/${general.id}/typing`, { method: 'POST', token: ownerToken });
  check('the typing endpoint accepts a ping', typingPing.status === 204, `status ${typingPing.status}`);

  const typingWatcher = await openGateway({ token: bobToken });
  await req(`/channels/${general.id}/typing`, { method: 'POST', token: ownerToken });
  await sleep(250);
  const typingEvent = typingWatcher.events.find((frame) => frame.t === 'TYPING_START');
  check(
    'typing is broadcast with the user and channel',
    typingEvent?.d?.channelId === general.id && typingEvent?.d?.user?.id === owner.json?.user?.id,
  );

  const typingOff = await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { showTyping: false } });
  check('typing can be turned off', typingOff.json?.user?.showTyping === false);

  typingWatcher.events.length = 0;
  await req(`/channels/${general.id}/typing`, { method: 'POST', token: ownerToken });
  await sleep(250);
  check(
    'a user with typing off broadcasts nothing',
    typingWatcher.events.every((frame) => frame.t !== 'TYPING_START'),
  );

  const typingBackOn = await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { showTyping: true } });
  check('typing can be turned back on', typingBackOn.json?.user?.showTyping === true);
  typingWatcher.ws.close();

  // --- Link previews ---
  check('embeddable urls are found', listEmbeddableUrls('see https://example.com/a').includes('https://example.com/a'));
  check('masked links are not unfurled', listEmbeddableUrls('[x](https://example.com/a)').length === 0);
  check('angle links are not unfurled', listEmbeddableUrls('<https://example.com/a>').length === 0);
  check('urls inside code are not unfurled', listEmbeddableUrls('`https://example.com/a`').length === 0);
  check(
    'trailing punctuation is trimmed from a link',
    listEmbeddableUrls('see https://example.com/a.').includes('https://example.com/a'),
  );

  check('loopback is refused', isPrivateAddress('127.0.0.1') === true && isPrivateAddress('::1') === true);
  check(
    'private ranges are refused',
    isPrivateAddress('10.1.2.3') &&
      isPrivateAddress('192.168.1.1') &&
      isPrivateAddress('172.16.5.5') &&
      isPrivateAddress('169.254.1.1') &&
      isPrivateAddress('fd00::1'),
  );
  check('public addresses are allowed', isPrivateAddress('1.1.1.1') === false && isPrivateAddress('8.8.8.8') === false);

  const metadata = parseEmbedMetadata(
    '<html><head><title>Fallback</title>' +
      '<meta property="og:title" content="OG &amp; Title">' +
      '<meta name="description" content="A description"></head></html>',
    'https://example.com/post',
  );
  check('the open graph title wins over the title tag', metadata.title === 'OG & Title');
  check('the description is read', metadata.description === 'A description');
  check('the site name falls back to the host', metadata.siteName === 'example.com');

  // A message linking to a private address must never be fetched.
  const privateLink = await req(`/channels/${general.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'http://127.0.0.1:9/secret' },
  });
  await sleep(300);
  const privateHistory = await req(`/channels/${general.id}/messages?limit=1`, { token: ownerToken });
  check(
    'a private address is never unfurled',
    privateHistory.json?.messages?.[0]?.id === privateLink.json?.id && privateHistory.json?.messages?.[0]?.embed === null,
  );

  // --- Presence ---
  await sleep(200);
  const rosterRes = await req('/members/roster', { token: ownerToken });
  check(
    'the roster lists members with roles and presence',
    Array.isArray(rosterRes.json?.members) &&
      rosterRes.json.members.every(
        (entry) => typeof entry.online === 'boolean' && Array.isArray(entry.roleIds) && Boolean(entry.user?.id),
      ),
  );
  check('everyone starts offline', rosterRes.json?.members?.every((entry) => entry.online === false));

  const presenceWatcher = await openGateway({ token: ownerToken });
  const bobGateway = await openGateway({ token: bobToken });
  await sleep(300);
  check(
    'a member coming online is announced',
    presenceWatcher.events.some(
      (frame) => frame.t === 'PRESENCE_UPDATE' && frame.d?.user?.id === bob.json?.user?.id && frame.d?.online === true,
    ),
  );
  check(
    'the roster reports them online',
    (await req('/members/roster', { token: ownerToken })).json?.members?.find(
      (entry) => entry.user.id === bob.json?.user?.id,
    )?.online === true,
  );

  bobGateway.ws.close();
  await sleep(400);
  check(
    'a member going offline is announced',
    presenceWatcher.events.some(
      (frame) => frame.t === 'PRESENCE_UPDATE' && frame.d?.user?.id === bob.json?.user?.id && frame.d?.online === false,
    ),
  );
  presenceWatcher.ws.close();

  // --- Theme derivation ---
  const defaults = deriveTheme(null);
  check(
    'an untouched instance derives the built-in palette',
    defaults.scheme === 'dark' && defaults.bg === DEFAULT_BACKGROUND && defaults.accent === DEFAULT_ACCENT,
  );
  check('dark backgrounds get light text', relativeLuminance(defaults.text) > 0.5);

  const light = deriveTheme({ background: '#f5f5f5', accent: '#1a73e8' });
  check('light backgrounds are detected', light.scheme === 'light');
  check('light backgrounds get dark text', relativeLuminance(light.text) < 0.2);
  check('light themes flip the overlay to black', light.hover.startsWith('rgb(0 0 0'));
  check('dark themes keep a white overlay', defaults.hover.startsWith('rgb(255 255 255'));
  check('panels stay distinct from the background', light.bgElevated !== light.bg && light.bgDeep !== light.bg);

  check('an unparseable colour falls back to the default', deriveTheme({ background: 'nonsense' }).bg === DEFAULT_BACKGROUND);
  check('a bright accent takes dark text', deriveTheme({ accent: '#ffd700' }).onAccent === '#000000');
  check('a dark accent takes light text', deriveTheme({ accent: '#1a3ea8' }).onAccent === '#ffffff');
  check('a near black background still separates its panels', deriveTheme({ background: '#050505' }).bgElevated !== '#050505');

  // --- Channel locking ---
  const staffRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Staff' } });
  const staffChannel = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'staff-only', requiredRoleId: staffRole.json.id },
  });
  check('a channel can require a role', staffChannel.json?.requiredRoleId === staffRole.json.id);

  const badRole = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'bad-lock', requiredRoleId: 'no-such-role' },
  });
  check('a channel lock must name a real role (400)', badRole.status === 400, `status ${badRole.status}`);

  const seesStaffChannel = async (token) =>
    (await req('/channels', { token })).json?.channels?.some((channel) => channel.id === staffChannel.json.id);
  check('a locked channel is hidden from a member without the role', (await seesStaffChannel(bobToken)) === false);
  check('a locked channel is listed for an administrator', (await seesStaffChannel(ownerToken)) === true);
  check(
    'reading a locked channel is refused (403)',
    (await req(`/channels/${staffChannel.json.id}/messages`, { token: bobToken })).status === 403,
  );
  check(
    'posting to a locked channel is refused (403)',
    (
      await req(`/channels/${staffChannel.json.id}/messages`, {
        method: 'POST',
        token: bobToken,
        body: { content: 'let me in' },
      })
    ).status === 403,
  );

  // Locked traffic must not reach a member who cannot see the channel.
  const lockWatcher = await openGateway({ token: bobToken });
  await req(`/channels/${staffChannel.json.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'a secret' },
  });
  await sleep(250);
  check(
    'a locked channel broadcasts nothing to a member without the role',
    lockWatcher.events.every((frame) => frame.t !== 'MESSAGE_CREATE' || frame.d?.channelId !== staffChannel.json.id),
  );

  // Granting the role opens it up live.
  await req(`/members/${bob.json.user.id}/roles/${staffRole.json.id}`, { method: 'PUT', token: ownerToken });
  await sleep(200);
  check('granting the role reveals the channel', (await seesStaffChannel(bobToken)) === true);
  await req(`/channels/${staffChannel.json.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'welcome' },
  });
  await sleep(250);
  check(
    'the unlocked channel now reaches the member',
    lockWatcher.events.some(
      (frame) => frame.t === 'MESSAGE_CREATE' && frame.d?.channelId === staffChannel.json.id,
    ),
  );
  lockWatcher.ws.close();

  // A locked category covers every channel inside it.
  const staffCategory = await req('/categories', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Staff area', requiredRoleId: staffRole.json.id },
  });
  await req(`/members/${bob.json.user.id}/roles/${staffRole.json.id}`, { method: 'DELETE', token: ownerToken });
  await sleep(200);
  const insideCategory = await req('/channels', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'staff-room', categoryId: staffCategory.json.id },
  });
  const bobList = await req('/channels', { token: bobToken });
  check(
    'a locked category hides its channels and itself',
    bobList.json?.channels?.every((channel) => channel.categoryId !== staffCategory.json.id) &&
      bobList.json?.categories?.every((category) => category.id !== staffCategory.json.id),
  );
  check(
    'the locked category is still visible to an administrator',
    (await req('/channels', { token: ownerToken })).json?.channels?.some(
      (channel) => channel.id === insideCategory.json.id,
    ) === true,
  );

  await req(`/channels/${insideCategory.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/categories/${staffCategory.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/channels/${staffChannel.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/roles/${staffRole.json.id}`, { method: 'DELETE', token: ownerToken });

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

  // The public directory is readable by every member, because mentions need it.
  const directory = await req('/members/directory', { token: bobToken });
  check(
    'any member reads the user directory',
    directory.status === 200 && directory.json?.users?.length >= 3,
  );
  check(
    'the directory carries no roles or permissions',
    directory.json?.users?.every((user) => !('permissions' in user) && !('roleIds' in user)) === true,
  );
  check('the user directory requires auth (401)', (await req('/members/directory')).status === 401);

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

  // --- Discord emoji import, with no bridge configured ---
  const discordEmoji = await req('/emojis/discord', { token: ownerToken });
  check(
    'the discord emoji preview reports no guild without a bridge',
    discordEmoji.status === 200 && discordEmoji.json?.guildName === null && discordEmoji.json?.emojis?.length === 0,
  );
  check('member cannot preview discord emoji (403)', (await req('/emojis/discord', { token: bobToken })).status === 403);
  check(
    'importing with no bridge connected reports 503',
    (await req('/emojis/import', { method: 'POST', token: ownerToken })).status === 503,
  );
  check(
    'member cannot import discord emoji (403)',
    (await req('/emojis/import', { method: 'POST', token: bobToken })).status === 403,
  );

  // --- Discord channel import, with no bridge configured ---
  const discordChannelPreview = await req('/channels/discord', { token: ownerToken });
  check(
    'the discord channel preview reports no guild without a bridge',
    discordChannelPreview.status === 200 &&
      discordChannelPreview.json?.guildName === null &&
      discordChannelPreview.json?.groups?.length === 0,
  );
  check(
    'member cannot preview discord channels (403)',
    (await req('/channels/discord', { token: bobToken })).status === 403,
  );
  check(
    'importing channels with no bridge connected reports 503',
    (await req('/channels/import', { method: 'POST', token: ownerToken })).status === 503,
  );
  check(
    'member cannot import discord channels (403)',
    (await req('/channels/import', { method: 'POST', token: bobToken })).status === 403,
  );

  // --- Retention and pruning ---
  const retention = await req('/retention', { token: ownerToken });
  check(
    'owner reads retention settings',
    retention.status === 200 &&
      retention.json?.settings?.imageRetentionDays === null &&
      retention.json?.settings?.auditRetentionDays === null,
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

  // Clip retention runs on its own schedule, independent of images.
  const clipUpload = new FormData();
  clipUpload.append('file', new Blob([MP4], { type: 'video/mp4' }), 'aged.mp4');
  const agedClip = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: clipUpload,
    })
  ).json();
  await req(`/channels/${colourChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'aged clip', attachmentIds: [agedClip.id] },
  });
  await req('/retention', { method: 'PATCH', token: ownerToken, body: { videoRetentionDays: 0 } });
  const clipPruned = await req('/retention/run', { method: 'POST', token: ownerToken });
  check('video retention deletes clips', clipPruned.json?.summary?.deletedAttachments > 0);
  check(
    'expired clip is no longer served (404)',
    (
      await fetch(`${BASE}/attachments/${agedClip.id}`, {
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
  check(
    'avatar is fetchable without a session when the hash is presented',
    (await fetch(`${BASE}/users/${avatarUser.user.id}/avatar?v=${avatarHash}`)).status === 200,
  );
  check(
    'a wrong hash does not bypass auth (401)',
    (await fetch(`${BASE}/users/${avatarUser.user.id}/avatar?v=not-the-hash`)).status === 401,
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

  // --- Instance icon ---
  const iconPng = await sharp({
    create: { width: 40, height: 40, channels: 4, background: { r: 88, g: 101, b: 242, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const bobIcon = new FormData();
  bobIcon.append('file', new Blob([iconPng], { type: 'image/png' }), 'icon.png');
  check(
    'member cannot upload a server icon (403)',
    (
      await fetch(`${BASE}/icon`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${bobToken}` },
        body: bobIcon,
      })
    ).status === 403,
  );

  check('no icon is set by default (404)', (await req('/icon')).status === 404);
  check('meta reports no icon hash by default', (await req('/meta')).json?.iconHash === null);

  const ownerIcon = new FormData();
  ownerIcon.append('file', new Blob([iconPng], { type: 'image/png' }), 'icon.png');
  const iconRes = await fetch(`${BASE}/icon`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: ownerIcon,
  });
  const iconBody = await iconRes.json();
  check(
    'owner uploads a server icon',
    iconRes.status === 200 && typeof iconBody.iconHash === 'string',
    JSON.stringify(iconBody),
  );

  const servedIcon = await fetch(`${BASE}/icon?v=${iconBody.iconHash}`);
  const iconBytes = Buffer.from(await servedIcon.arrayBuffer());
  check(
    'the icon is served as png without a session',
    servedIcon.status === 200 && servedIcon.headers.get('content-type') === 'image/png' && iconBytes.length > 0,
  );
  check('meta now reports the icon hash', (await req('/meta')).json?.iconHash === iconBody.iconHash);

  const notAnIcon = new FormData();
  notAnIcon.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'n.txt');
  check(
    'a non-image icon is rejected (415)',
    (
      await fetch(`${BASE}/icon`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${ownerToken}` },
        body: notAnIcon,
      })
    ).status === 415,
  );

  // The icon is a blob like any other, so the pruner must know it is referenced.
  await req('/retention/run', { method: 'POST', token: ownerToken });
  check('the icon survives pruning', (await fetch(`${BASE}/icon?v=${iconBody.iconHash}`)).status === 200);

  check('owner resets the icon', (await req('/icon', { method: 'DELETE', token: ownerToken })).json?.iconHash === null);
  check('the icon is gone after a reset (404)', (await req('/icon')).status === 404);
  check('meta forgets the icon hash after a reset', (await req('/meta')).json?.iconHash === null);

  // Bridge settings: outbound avatars need a real public address, but a blank
  // value (turning them off) must stay allowed.
  check(
    'bridge rejects a malformed public base URL (400)',
    (await req('/bridge', { method: 'PATCH', token: ownerToken, body: { publicBaseUrl: 'not a url' } })).status === 400,
  );
  check(
    'bridge accepts a valid public base URL',
    (await req('/bridge', { method: 'PATCH', token: ownerToken, body: { publicBaseUrl: 'https://chat.example.com/' } })).json
      ?.publicBaseUrl === 'https://chat.example.com/',
  );
  check(
    'bridge can clear the public base URL',
    (await req('/bridge', { method: 'PATCH', token: ownerToken, body: { publicBaseUrl: '' } })).json?.publicBaseUrl === null,
  );

  check(
    'display name can be cleared',
    (await req('/users/@me', { method: 'PATCH', token: ownerToken, body: { displayName: null } })).json?.user
      ?.displayName === null,
  );

  // --- Moderation: timeouts, kicks and bans ---
  const modInvite = await req('/invites', { method: 'POST', token: ownerToken, body: {} });
  const modTarget = await req('/auth/register', {
    method: 'POST',
    body: { username: 'modtarget', password: 'hunter2hunter2', inviteCode: modInvite.json?.code },
  });
  const modToken = modTarget.json?.token;
  const modId = modTarget.json?.user?.id;
  const ownerId = owner.json?.user?.id;

  // Nobody may moderate an administrator (including the owner), themselves, or
  // exercise a permission they do not hold.
  const tempAdminRole = await req('/roles', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Temp Admin', permissions: '16384' },
  });
  await req(`/members/${bobId}/roles/${tempAdminRole.json?.id}`, { method: 'PUT', token: ownerToken });
  check(
    'an administrator cannot be timed out (403)',
    (await req(`/members/${bobId}/timeout`, {
      method: 'PUT',
      token: ownerToken,
      body: { durationMinutes: 5 },
    })).status === 403,
  );
  check(
    'an administrator cannot be kicked (403)',
    (await req(`/members/${bobId}/kick`, { method: 'POST', token: ownerToken })).status === 403,
  );
  await req(`/members/${bobId}/roles/${tempAdminRole.json?.id}`, { method: 'DELETE', token: ownerToken });

  check(
    'you cannot kick yourself (400)',
    (await req(`/members/${ownerId}/kick`, { method: 'POST', token: ownerToken })).status === 400,
  );
  check(
    'a member without permission cannot kick (403)',
    (await req(`/members/${modId}/kick`, { method: 'POST', token: modToken })).status === 403,
  );

  // A timeout stops posting but not reading.
  check(
    'an administrator can time out a member',
    (await req(`/members/${modId}/timeout`, {
      method: 'PUT',
      token: ownerToken,
      body: { durationMinutes: 5 },
    })).status === 204,
  );
  check(
    'a timed-out member cannot post (403)',
    (await req(`/channels/${colourChannel.id}/messages`, {
      method: 'POST',
      token: modToken,
      body: { content: 'nope' },
    })).status === 403,
  );
  check(
    'a timed-out member can still read',
    (await req(`/channels/${colourChannel.id}/messages`, { token: modToken })).status === 200,
  );
  check(
    'a timeout can be lifted',
    (await req(`/members/${modId}/timeout`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'posting works again after a timeout',
    (await req(`/channels/${colourChannel.id}/messages`, {
      method: 'POST',
      token: modToken,
      body: { content: 'back' },
    })).status === 200,
  );

  // A kick ends their session; they may sign back in.
  check(
    'an administrator can kick a member',
    (await req(`/members/${modId}/kick`, { method: 'POST', token: ownerToken })).status === 204,
  );
  check('a kicked member is logged out (401)', (await req('/auth/me', { token: modToken })).status === 401);

  // A ban blocks login until it is lifted.
  check(
    'an administrator can ban a member',
    (await req(`/members/${modId}/ban`, {
      method: 'PUT',
      token: ownerToken,
      body: { reason: 'testing' },
    })).status === 204,
  );
  check(
    'a banned member cannot sign in (403)',
    (await req('/auth/login', { method: 'POST', body: { username: 'modtarget', password: 'hunter2hunter2' } })).status ===
      403,
  );
  check(
    'banned members leave the directory',
    (await req('/members/directory', { token: ownerToken })).json?.users?.some((user) => user.id === modId) === false,
  );
  const banList = await req('/bans', { token: ownerToken });
  check(
    'bans are listed with their reason',
    banList.json?.bans?.some((ban) => ban.user.id === modId && ban.reason === 'testing') === true,
  );
  check(
    'an administrator can unban',
    (await req(`/members/${modId}/ban`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'an unbanned member can sign in again',
    (await req('/auth/login', { method: 'POST', body: { username: 'modtarget', password: 'hunter2hunter2' } })).status ===
      200,
  );
  check(
    'the directory includes them again',
    (await req('/members/directory', { token: ownerToken })).json?.users?.some((user) => user.id === modId) === true,
  );

  // --- Audit log ---
  check('the audit log needs ManageServer (403)', (await req('/audit', { token: bobToken })).status === 403);

  // Produce one of each kind here, so the assertions below cannot depend on how
  // much earlier activity has pushed older entries off the first page. The
  // target is modtarget rather than bob, because kicking ends their sessions
  // and the checks that follow still use bob's token.
  const auditRole = await req('/roles', { method: 'POST', token: ownerToken, body: { name: 'Audited' } });
  await req(`/members/${modId}/roles/${auditRole.json.id}`, { method: 'PUT', token: ownerToken });
  await req(`/members/${modId}/roles/${auditRole.json.id}`, { method: 'DELETE', token: ownerToken });
  await req(`/members/${modId}/timeout`, { method: 'PUT', token: ownerToken, body: { durationMinutes: 5 } });
  await req(`/members/${modId}/timeout`, { method: 'DELETE', token: ownerToken });
  await req(`/members/${modId}/kick`, { method: 'POST', token: ownerToken });
  await req(`/members/${modId}/ban`, { method: 'PUT', token: ownerToken, body: { reason: 'audit check' } });
  await req(`/members/${modId}/ban`, { method: 'DELETE', token: ownerToken });

  const auditedMessage = await req(`/channels/${colourChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'original text' },
  });
  await req(`/messages/${auditedMessage.json.id}`, {
    method: 'PATCH',
    token: ownerToken,
    body: { content: 'changed text' },
  });
  await req(`/messages/${auditedMessage.json.id}`, { method: 'DELETE', token: ownerToken });

  // A deletion that carried an image keeps a link to the file, since only the
  // message row is soft-deleted and the bytes are still on disk.
  const auditUpload = new FormData();
  auditUpload.append('file', new Blob([emojiPng], { type: 'image/png' }), 'audited.png');
  const auditAttachment = await (
    await fetch(`${BASE}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}` },
      body: auditUpload,
    })
  ).json();
  const imageMessage = await req(`/channels/${colourChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'has an image', attachmentIds: [auditAttachment.id] },
  });
  await req(`/messages/${imageMessage.json.id}`, { method: 'DELETE', token: ownerToken });

  const audit = (await req('/audit?limit=100', { token: ownerToken })).json;
  const auditKinds = new Set((audit?.entries ?? []).map((entry) => entry.kind));
  check(
    'every audited kind is recorded',
    [
      'message_edit',
      'message_delete',
      'timeout_add',
      'timeout_clear',
      'kick',
      'ban',
      'unban',
      'role_add',
      'role_remove',
    ].every((kind) => auditKinds.has(kind)),
    [...auditKinds].join(', '),
  );

  const editedEntry = (audit?.entries ?? []).find(
    (entry) => entry.kind === 'message_edit' && entry.detail.before === 'original text',
  );
  check(
    'an edit keeps the text either side',
    editedEntry?.detail?.after === 'changed text' && editedEntry?.detail?.channelName === colourChannel.name,
  );

  const removedEntry = (audit?.entries ?? []).find(
    (entry) => entry.kind === 'message_delete' && entry.detail.before === 'changed text',
  );
  check('a deletion keeps the text that was removed', Boolean(removedEntry));

  const imageEntry = (audit?.entries ?? []).find(
    (entry) => entry.kind === 'message_delete' && entry.detail.before === 'has an image',
  );
  check(
    'a deletion keeps a link to the images it carried',
    imageEntry?.detail.attachments?.[0]?.filename === 'audited.png',
    JSON.stringify(imageEntry?.detail),
  );
  check(
    'the deleted image is still served so the log can show it',
    (
      await fetch(`${BASE}/attachments/${auditAttachment.id}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      })
    ).status === 200,
  );

  const banEntry = (audit?.entries ?? []).find(
    (entry) => entry.kind === 'ban' && entry.detail.reason === 'audit check',
  );
  check(
    'an entry names the actor and the target',
    banEntry?.actor?.username === 'alice' && banEntry?.target?.username === 'modtarget',
  );

  const roleEntry = (audit?.entries ?? []).find(
    (entry) => entry.kind === 'role_add' && entry.detail.roleName === 'Audited',
  );
  check('a role change records the role name', Boolean(roleEntry));

  const newest = audit?.entries?.[0];
  const olderPage = newest
    ? await req(
        `/audit?limit=1&before=${encodeURIComponent(newest.createdAt)}&beforeId=${newest.id}`,
        { token: ownerToken },
      )
    : { status: 0, json: null };
  check(
    'the audit log pages backwards',
    olderPage.status === 200 && olderPage.json?.entries?.length === 1 && olderPage.json.entries[0].id !== newest?.id,
  );

  await req(`/roles/${auditRole.json.id}`, { method: 'DELETE', token: ownerToken });

  // --- Admin media gallery ---
  const galleryPng = await sharp({
    create: { width: 20, height: 14, channels: 3, background: { r: 12, g: 34, b: 56 } },
  })
    .png()
    .toBuffer();
  const galleryForm = new FormData();
  galleryForm.append('file', new Blob([galleryPng], { type: 'image/png' }), 'gallery.png');
  const galleryUpload = await fetch(`${BASE}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: galleryForm,
  });
  const galleryAttachment = await galleryUpload.json();

  const gallery = await req('/media', { token: ownerToken });
  const galleryItem = gallery.json?.media?.find((item) => item.attachment.id === galleryAttachment.id);
  check(
    'the media gallery lists stored images',
    gallery.status === 200 && galleryItem !== undefined,
  );
  check('a media item resolves its uploader', galleryItem?.uploader?.username === 'alice');
  check('a member cannot read the media gallery (403)', (await req('/media', { token: bobToken })).status === 403);
  check(
    'a member cannot delete media (403)',
    (await req(`/attachments/${galleryAttachment.id}`, { method: 'DELETE', token: bobToken })).status === 403,
  );
  check(
    'an administrator can delete media',
    (await req(`/attachments/${galleryAttachment.id}`, { method: 'DELETE', token: ownerToken })).status === 204,
  );
  check(
    'deleted media leaves the gallery',
    (await req('/media', { token: ownerToken })).json?.media?.some(
      (item) => item.attachment.id === galleryAttachment.id,
    ) === false,
  );
  check(
    'deleting a missing attachment 404s',
    (await req(`/attachments/${galleryAttachment.id}`, { method: 'DELETE', token: ownerToken })).status === 404,
  );

  // Deleting from the gallery is a loggable admin action, unlike the soft delete
  // of a message which only hides it.
  const afterGallery = (await req('/audit?limit=100', { token: ownerToken })).json;
  const mediaEntry = (afterGallery?.entries ?? []).find((entry) => entry.kind === 'media_delete');
  check(
    'deleting media from the gallery is logged with the file name',
    mediaEntry?.detail.filename === 'gallery.png',
    JSON.stringify(mediaEntry?.detail),
  );

  // --- Audit retention and clearing ---
  check('a member cannot clear the log (403)', (await req('/audit', { method: 'DELETE', token: bobToken })).status === 403);
  check('the log can be cleared', (await req('/audit', { method: 'DELETE', token: ownerToken })).status === 204);
  check('the log is empty after clearing', (await req('/audit', { token: ownerToken })).json?.entries?.length === 0);

  const auditDays = await req('/retention', {
    method: 'PATCH',
    token: ownerToken,
    body: { auditRetentionDays: 30 },
  });
  check(
    'audit retention is saved',
    auditDays.json?.settings?.auditRetentionDays === 30,
    JSON.stringify(auditDays.json?.settings),
  );

  // Make a fresh entry, then let retention age it out.
  const toPruneFromLog = await req(`/channels/${colourChannel.id}/messages`, {
    method: 'POST',
    token: ownerToken,
    body: { content: 'prune me from the log' },
  });
  await req(`/messages/${toPruneFromLog.json.id}`, { method: 'DELETE', token: ownerToken });
  check(
    'a fresh entry is in the log',
    (await req('/audit', { token: ownerToken })).json?.entries?.length > 0,
  );

  await req('/retention', { method: 'PATCH', token: ownerToken, body: { auditRetentionDays: 0 } });
  const auditPruned = await req('/retention/run', { method: 'POST', token: ownerToken });
  check(
    'audit retention deletes old log entries',
    auditPruned.json?.summary?.deletedAuditEntries > 0,
    JSON.stringify(auditPruned.json?.summary),
  );
  check(
    'the log is empty after audit retention',
    (await req('/audit', { token: ownerToken })).json?.entries?.length === 0,
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
