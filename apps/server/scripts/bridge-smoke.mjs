// Bridge orchestration test.
//
// Substitutes a fake Discord transport so the mirroring logic can be verified
// without a bot token or a network connection. Run with:
//   npm run smoke:bridge --workspace @harmony/server
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Database } from '../src/db/index.ts';
import { insertChannel } from '../src/db/channels.ts';
import { insertUser } from '../src/db/users.ts';
import { findBridgeMessageByHarmonyId } from '../src/db/bridge.ts';
import { GatewayHub } from '../src/realtime/hub.ts';
import { createSettingsService } from '../src/settings/service.ts';
import { createMessageService } from '../src/messages/service.ts';
import { createBridgeService } from '../src/bridge/service.ts';

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

function createFakeTransport() {
  const state = { started: false, ready: false, mirrors: [], handlers: [] };
  return {
    state,
    async start() {
      state.started = true;
      state.ready = true;
    },
    async stop() {
      state.ready = false;
    },
    status() {
      return { ready: state.ready, botTag: 'fake#0001', guildName: 'Test Guild', error: null };
    },
    async listTextChannels() {
      return { guildName: 'Test Guild', channels: [{ id: '111', name: 'general' }] };
    },
    onMessage(handler) {
      state.handlers.push(handler);
    },
    async mirror(input) {
      state.mirrors.push(input);
      return { messageId: `discord-${state.mirrors.length}`, webhook: input.webhook ?? { id: 'wh1', token: 'tok1' } };
    },
    emit(message) {
      for (const handler of state.handlers) handler(message);
    },
  };
}

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-bridge-'));
const db = new Database({ dataDir, dbFile: join(dataDir, 'harmony.db') });
const settings = createSettingsService(db.sqlite, { serverName: 'Test', requireInvite: false });
const hub = new GatewayHub();
const messages = createMessageService(db.sqlite, hub);
const transport = createFakeTransport();

const bridge = createBridgeService({
  sqlite: db.sqlite,
  settings,
  messages,
  logger: { info() {}, debug() {} },
  transportFactory: () => transport,
});

try {
  // 1. Nothing happens until the bridge is configured and enabled.
  await bridge.applySettings();
  check('bridge is idle before configuration', transport.state.started === false);
  check('status reports unconfigured', bridge.status().configured === false && bridge.status().enabled === false);
  check('status never leaks a token', !('token' in bridge.status()));

  // 2. Enabling with a token starts the transport.
  settings.updateBridge({ token: 'fake-token', enabled: true });
  await bridge.applySettings();
  check('transport starts once enabled', transport.state.started === true);
  check('status reports ready', bridge.status().status.ready === true);
  check('bot identity is exposed', bridge.status().status.botTag === 'fake#0001');

  const discordChannels = await bridge.listDiscordChannels();
  check('discord channels are listable', discordChannels.channels.length === 1);

  // Seed a Harmony user, channel and Discord mapping.
  const userId = randomUUID();
  insertUser(db.sqlite, { id: userId, username: 'alice', passwordHash: 'scrypt$x$y$z', isOwner: true });
  const channelId = randomUUID();
  insertChannel(db.sqlite, {
    id: channelId,
    name: 'general',
    topic: null,
    categoryId: null,
    type: 'text',
    position: 0,
    createdAt: new Date().toISOString(),
    discordChannelId: '111',
  });

  // 3. Harmony -> Discord: mirrored with the author's name and no mentions.
  const auth = { user: { id: userId }, permissions: 0n, sessionId: 's', token: 't' };
  const sent = messages.create(auth, channelId, 'hello discord', []);
  await sleep(50);

  check('harmony message is mirrored', transport.state.mirrors.length === 1);
  check('mirror uses a username override', transport.state.mirrors[0]?.username === 'alice');
  check('mirror carries the content', transport.state.mirrors[0]?.content === 'hello discord');
  check(
    'mirrored message is recorded for later sync',
    findBridgeMessageByHarmonyId(db.sqlite, sent.id)?.discord_message_id === 'discord-1',
  );

  // 4. The webhook is cached after first use.
  messages.create(auth, channelId, 'second', []);
  await sleep(50);
  check('cached webhook is reused', transport.state.mirrors[1]?.webhook?.id === 'wh1');

  // 5. Discord -> Harmony: attributed to a ghost user.
  transport.emit({
    id: 'd1',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    content: 'hi harmony',
    fromBot: false,
  });
  await sleep(50);

  const history = messages.history(channelId, { limit: 50 });
  const ingested = history.messages.find((message) => message.content === 'hi harmony');
  check('discord message lands in harmony', Boolean(ingested));
  check('ingested message is attributed to a ghost user', ingested?.author?.isBot === true);
  check('ghost user carries the discord display name', ingested?.author?.displayName === 'Discord Sam');
  check('ingested messages are not mirrored back', transport.state.mirrors.length === 2);

  // 6. The same Discord author reuses one ghost account.
  transport.emit({
    id: 'd2',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    content: 'again',
    fromBot: false,
  });
  await sleep(50);
  const again = messages.history(channelId, { limit: 50 }).messages.find((m) => m.content === 'again');
  check('ghost user is reused across messages', again?.author?.id === ingested?.author?.id);

  // 7. Bots and webhooks never get ingested.
  const before = messages.history(channelId, { limit: 100 }).messages.length;
  transport.emit({ id: 'd3', channelId: '111', authorId: 'wh', authorName: 'Harmony', content: 'echo', fromBot: true });
  await sleep(50);
  check(
    'bot/webhook messages are ignored',
    messages.history(channelId, { limit: 100 }).messages.length === before,
  );

  // 8. Discord channels that are not mapped are ignored.
  transport.emit({
    id: 'd4',
    channelId: '222',
    authorId: '999',
    authorName: 'Discord Sam',
    content: 'elsewhere',
    fromBot: false,
  });
  await sleep(50);
  check(
    'unmapped discord channels are ignored',
    messages.history(channelId, { limit: 100 }).messages.length === before,
  );

  // 9. The admin test message surfaces problems clearly.
  const unbridgedId = randomUUID();
  insertChannel(db.sqlite, {
    id: unbridgedId,
    name: 'unbridged',
    topic: null,
    categoryId: null,
    type: 'text',
    position: 1,
    createdAt: new Date().toISOString(),
    discordChannelId: null,
  });

  let testError = '';
  try {
    await bridge.testMirror(unbridgedId);
  } catch (error) {
    testError = error instanceof Error ? error.message : String(error);
  }
  check('test message explains an unbridged channel', testError.includes('not linked'), testError);

  const mirrorsBeforeTest = transport.state.mirrors.length;
  await bridge.testMirror(channelId);
  check('test message reaches discord', transport.state.mirrors.length === mirrorsBeforeTest + 1);

  // 10. Disabling stops the transport.
  settings.updateBridge({ enabled: false });
  await bridge.applySettings();
  check('transport stops when disabled', transport.state.ready === false);
} catch (error) {
  failures++;
  console.error('UNEXPECTED ERROR:', error);
} finally {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
