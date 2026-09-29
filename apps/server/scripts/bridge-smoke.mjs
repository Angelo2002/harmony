// Bridge orchestration test.
//
// Substitutes a fake Discord transport so the mirroring logic can be verified
// without a bot token or a network connection. Run with:
//   npm run smoke:bridge --workspace @harmony/server
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { Database } from '../src/db/index.ts';
import { insertChannel, listChannels } from '../src/db/channels.ts';
import { listCategories } from '../src/db/categories.ts';
import { findUserById, findUserByDiscordId, insertUser } from '../src/db/users.ts';
import { findBridgeMessageByHarmonyId } from '../src/db/bridge.ts';
import { insertEmoji } from '../src/db/emojis.ts';
import { createAttachmentService } from '../src/attachments/service.ts';
import { createEmojiService } from '../src/emojis/service.ts';
import { createEmojiImportService } from '../src/emojis/import.ts';
import { GatewayHub } from '../src/realtime/hub.ts';
import { createSettingsService } from '../src/settings/service.ts';
import { createMessageService } from '../src/messages/service.ts';
import { createAuditService } from '../src/audit/service.ts';
import { createUserService } from '../src/users/service.ts';
import { createBridgeService } from '../src/bridge/service.ts';
import { createChannelImportService } from '../src/channels/import.ts';

const logger = { info() {}, debug() {} };

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

function createFakeTransport() {
  const state = {
    started: false,
    ready: false,
    mirrors: [],
    edits: [],
    deletes: [],
    reactions: [],
    created: [],
    edited: [],
    deleted: [],
    reactionAdded: [],
    reactionRemoved: [],
    reactionCleared: [],
    guildEmojis: [{ id: '700', name: 'YES', animated: false }],
    recentMessages: [],
    downloadBytes: null,
    downloads: [],
  };
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
      return {
        guildName: 'Test Guild',
        categories: [{ id: 'cat1', name: 'General' }],
        channels: [
          { id: '111', name: 'general', categoryId: 'cat1' },
          { id: '222', name: 'random', categoryId: 'cat1' },
          { id: '333', name: 'offtopic', categoryId: null },
        ],
      };
    },
    onMessage(handler) {
      state.created.push(handler);
    },
    onMessageEdited(handler) {
      state.edited.push(handler);
    },
    onMessageDeleted(handler) {
      state.deleted.push(handler);
    },
    onReactionAdded(handler) {
      state.reactionAdded.push(handler);
    },
    onReactionRemoved(handler) {
      state.reactionRemoved.push(handler);
    },
    onReactionCleared(handler) {
      state.reactionCleared.push(handler);
    },
    async guildEmojis() {
      return state.guildEmojis;
    },
    async fetchRecentMessages() {
      return state.recentMessages;
    },
    async addReaction(input) {
      state.reactions.push({ kind: 'add', ...input });
    },
    async removeReaction(input) {
      state.reactions.push({ kind: 'remove', ...input });
    },
    async mirror(input) {
      state.mirrors.push(input);
      return { messageId: `discord-${state.mirrors.length}`, webhook: input.webhook ?? { id: 'wh1', token: 'tok1' } };
    },
    async editMessage(input) {
      state.edits.push(input);
    },
    async deleteMessage(input) {
      state.deletes.push(input);
    },
    async download(url) {
      state.downloads.push(url);
      return state.downloadBytes;
    },
    emit(message) {
      // Message fields the tests omit default to sensible values.
      for (const handler of state.created) {
        handler({ mentions: [], createdAt: new Date().toISOString(), ...message });
      }
    },
    emitEdit(edit) {
      for (const handler of state.edited) handler(edit);
    },
    emitDelete(deletion) {
      for (const handler of state.deleted) handler(deletion);
    },
    emitReactionAdd(reaction) {
      for (const handler of state.reactionAdded) handler(reaction);
    },
    emitReactionRemove(reaction) {
      for (const handler of state.reactionRemoved) handler(reaction);
    },
    emitReactionClear(reaction) {
      for (const handler of state.reactionCleared) handler(reaction);
    },
  };
}

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-bridge-'));
const config = {
  dataDir,
  dbFile: join(dataDir, 'harmony.db'),
  uploadDir: join(dataDir, 'uploads'),
  maxUploadBytes: 10 * 1024 * 1024,
};

const db = new Database(config);
const settings = createSettingsService(db.sqlite, { serverName: 'Test', requireInvite: false });
const hub = new GatewayHub();
const audit = createAuditService(db.sqlite);
const messages = createMessageService(db.sqlite, hub, audit);
const attachments = createAttachmentService(db.sqlite, config);
const users = createUserService(db.sqlite, config);
const transport = createFakeTransport();

const bridge = createBridgeService({
  sqlite: db.sqlite,
  config,
  settings,
  messages,
  users,
  logger,
  transportFactory: () => transport,
});

const png = await sharp({ create: { width: 10, height: 6, channels: 3, background: { r: 10, g: 200, b: 90 } } })
  .png()
  .toBuffer();

try {
  // 1. Nothing happens until the bridge is configured and enabled.
  await bridge.applySettings();
  check('bridge is idle before configuration', transport.state.started === false);
  check('status reports unconfigured', bridge.status().configured === false && bridge.status().enabled === false);
  check('status never leaks a token', !('token' in bridge.status()));

  settings.updateBridge({ token: 'fake-token', enabled: true });
  await bridge.applySettings();
  check('transport starts once enabled', transport.state.started === true);
  check('bot identity is exposed', bridge.status().status.botTag === 'fake#0001');
  check('discord channels are listable', (await bridge.listDiscordChannels()).channels.length === 3);
  check('discord categories are listable', (await bridge.listDiscordChannels()).categories.length === 1);

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
    requiredRoleId: null,
  });

  const auth = { user: { id: userId }, permissions: 0n, sessionId: 's', token: 't' };

  // 2. Harmony -> Discord, text.
  const sent = messages.create(auth, channelId, 'hello discord', [], null);
  await sleep(50);
  check('harmony message is mirrored', transport.state.mirrors.length === 1);
  check('mirror uses a username override', transport.state.mirrors[0]?.username === 'alice');
  check('mirror carries the content', transport.state.mirrors[0]?.content === 'hello discord');
  check('no avatar is sent without a public base URL', transport.state.mirrors[0]?.avatarUrl === null);
  check(
    'mirrored message is recorded for later sync',
    findBridgeMessageByHarmonyId(db.sqlite, sent.id)?.discord_message_id === 'discord-1',
  );

  // 3. Harmony -> Discord, with an image.
  const upload = await attachments.upload(auth, { filename: 'pic.png', contentType: 'image/png', data: png });
  messages.create(auth, channelId, '', [upload.id], null);
  await sleep(50);
  const withFile = transport.state.mirrors.at(-1);
  check('attachment is mirrored', withFile?.files.length === 1);
  check('mirrored file keeps its name', withFile?.files[0]?.filename === 'pic.png');
  check('a message can be images only', withFile?.content === '');

  // 4. Discord -> Harmony, with an image.
  transport.state.downloadBytes = png;
  const mirrorsBeforeIngest = transport.state.mirrors.length;
  transport.emit({
    id: 'd1',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: 'https://cdn.example/avatar.png',
    replyToDiscordId: null,
    content: 'hi harmony',
    attachments: [{ url: 'https://cdn.example/pic.png', filename: 'pic.png', contentType: 'image/png', size: png.length }],
    fromBot: false,
  });
  await sleep(50);

  const history = messages.history(channelId, { limit: 50 }, userId);
  const ingested = history.messages.find((message) => message.content === 'hi harmony');
  check('discord message lands in harmony', Boolean(ingested));
  check('ingested message is attributed to a ghost user', ingested?.author?.isBot === true);
  check('ghost user carries the discord display name', ingested?.author?.displayName === 'Discord Sam');
  check('discord attachment is mirrored', ingested?.attachments.length === 1);
  check(
    'discord attachment blob is stored',
    existsSync(join(config.uploadDir, ingested.attachments[0].hash.slice(0, 2), ingested.attachments[0].hash)),
  );
  check('ingested messages are not mirrored back', transport.state.mirrors.length === mirrorsBeforeIngest);
  check('discord avatar is imported for the ghost user', typeof ingested?.author?.avatarHash === 'string');
  check(
    'ghost avatar blob is stored',
    Boolean(
      ingested?.author?.avatarHash &&
        existsSync(join(config.uploadDir, ingested.author.avatarHash.slice(0, 2), ingested.author.avatarHash)),
    ),
  );
  check('discord avatar is fetched by URL', transport.state.downloads.includes('https://cdn.example/avatar.png'));

  // 4b. A Discord reply becomes a real Harmony reply.
  transport.emit({
    id: 'd1r',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: 'd1',
    content: 'a reply from discord',
    attachments: [],
    fromBot: false,
  });
  await sleep(50);
  const replyIngested = messages
    .history(channelId, { limit: 50 }, userId)
    .messages.find((message) => message.content === 'a reply from discord');
  check('discord reply references the bridged message', replyIngested?.replyTo?.id === ingested?.id);

  // 5. Unsupported attachments are preserved as links rather than dropped.
  transport.emit({
    id: 'd2',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: '',
    attachments: [{ url: 'https://cdn.example/notes.txt', filename: 'notes.txt', contentType: 'text/plain', size: 10 }],
    fromBot: false,
  });
  await sleep(50);
  check(
    'unsupported attachments become links',
    messages.history(channelId, { limit: 50 }, userId).messages.some((m) => m.content.includes('notes.txt')),
  );

  // 6. Edits and deletes, Discord -> Harmony.
  transport.emitEdit({ id: 'd1', channelId: '111', content: 'edited in discord' });
  await sleep(50);
  check(
    'discord edit reaches harmony',
    messages.history(channelId, { limit: 50 }, userId).messages.some((m) => m.content === 'edited in discord'),
  );

  transport.emitDelete({ id: 'd1', channelId: '111' });
  await sleep(50);
  check(
    'discord delete reaches harmony',
    messages.history(channelId, { limit: 50 }, userId).messages.every((m) => m.id !== ingested?.id),
  );

  // 7. Edits and deletes, Harmony -> Discord.
  const edited = messages.edit(auth, sent.id, 'edited in harmony');
  await sleep(50);
  check('harmony edit reaches discord', transport.state.edits.at(-1)?.content === 'edited in harmony');
  check('edit targets the mirrored message', transport.state.edits.at(-1)?.discordMessageId === 'discord-1');
  check('edit uses the cached webhook', transport.state.edits.at(-1)?.webhook?.id === 'wh1');

  messages.remove(auth, edited.id);
  await sleep(50);
  check('harmony delete reaches discord', transport.state.deletes.at(-1)?.discordMessageId === 'discord-1');

  // 7b. Outbound avatars are handed to Discord, but only once we know our own
  // public address, and the hash doubles as the fetch capability.
  await users.setAvatarFromData(userId, png);
  const aliceAvatarHash = findUserById(db.sqlite, userId)?.avatar_hash;
  settings.updateBridge({ publicBaseUrl: 'https://chat.example.com/' });
  messages.create(auth, channelId, 'avatar check', [], null);
  await sleep(50);
  check(
    'outbound avatar URL uses the public base URL and hash capability',
    transport.state.mirrors.at(-1)?.avatarUrl ===
      `https://chat.example.com/api/v1/users/${userId}/avatar?v=${aliceAvatarHash}`,
    String(transport.state.mirrors.at(-1)?.avatarUrl),
  );

  // 7c. A Harmony reply is mirrored out as a quoted line, since Discord
  // webhooks cannot post real replies.
  const original = messages.create(auth, channelId, 'the original', [], null);
  await sleep(50);
  messages.create(auth, channelId, 'replying here', [], original.id);
  await sleep(50);
  const quoted = transport.state.mirrors.at(-1);
  check(
    'outbound reply is mirrored as a quote',
    quoted?.content.startsWith('> **alice**') && quoted.content.includes('replying here'),
    String(quoted?.content),
  );

  // 7d. Reactions mirror out. Custom emoji are matched to the guild's emoji by name.
  const target = messages.create(auth, channelId, 'react to me', [], null);
  await sleep(50);
  messages.toggleReaction(auth, target.id, '👍', null);
  await sleep(50);
  check(
    'a unicode reaction is mirrored out',
    transport.state.reactions.at(-1)?.kind === 'add' &&
      transport.state.reactions.at(-1)?.emoji === encodeURIComponent('👍'),
    String(transport.state.reactions.at(-1)?.emoji),
  );
  check('the bot reacts in the linked discord channel', transport.state.reactions.at(-1)?.channelId === '111');

  insertEmoji(db.sqlite, {
    id: 'emoji-yes',
    name: 'YES',
    hash: 'deadbeef',
    contentType: 'image/png',
    animated: false,
    createdBy: userId,
    createdAt: new Date().toISOString(),
  });
  messages.toggleReaction(auth, target.id, ':YES:', 'emoji-yes');
  await sleep(50);
  check(
    'a custom reaction is translated to a discord emoji',
    transport.state.reactions.at(-1)?.emoji === 'YES:700',
    String(transport.state.reactions.at(-1)?.emoji),
  );

  messages.toggleReaction(auth, target.id, '👍', null);
  await sleep(50);
  check('removing a reaction is mirrored out', transport.state.reactions.at(-1)?.kind === 'remove');

  // A second reactor keeps the bot's single reaction until the last one leaves.
  const bobId = randomUUID();
  insertUser(db.sqlite, { id: bobId, username: 'bob', passwordHash: 'scrypt$x$y$z', isOwner: false });
  const bobAuth = { user: { id: bobId }, permissions: 0n, sessionId: 'sb', token: 'tb' };
  messages.toggleReaction(auth, target.id, '🔥', null);
  await sleep(50);
  messages.toggleReaction(bobAuth, target.id, '🔥', null);
  await sleep(50);
  const beforePartialRemove = transport.state.reactions.length;
  messages.toggleReaction(auth, target.id, '🔥', null);
  await sleep(50);
  check('the bot reaction stays while others remain', transport.state.reactions.length === beforePartialRemove);
  messages.toggleReaction(bobAuth, target.id, '🔥', null);
  await sleep(50);
  check(
    'the bot reaction is removed once the last reactor leaves',
    transport.state.reactions.at(-1)?.kind === 'remove' &&
      transport.state.reactions.at(-1)?.emoji === encodeURIComponent('🔥'),
    String(transport.state.reactions.at(-1)?.emoji),
  );

  // 7i. Importing a channel backfills recent Discord history, idempotently.
  transport.state.recentMessages = [
    {
      id: 'h1',
      channelId: '111',
      authorId: '888',
      authorName: 'Discord History',
      authorAvatarUrl: null,
      replyToDiscordId: null,
      mentions: [],
      createdAt: '2024-01-01T10:00:00.000Z',
      content: 'the first ever message',
      attachments: [],
      fromBot: false,
    },
    {
      id: 'h2',
      channelId: '111',
      authorId: '888',
      authorName: 'Discord History',
      authorAvatarUrl: null,
      replyToDiscordId: 'h1',
      mentions: [],
      createdAt: '2024-01-01T10:01:00.000Z',
      content: 'and a reply',
      attachments: [],
      fromBot: false,
    },
  ];

  check('an import pulls in discord history', (await bridge.importChannel(channelId)) === 2);
  const importedHistory = messages.history(channelId, { limit: 100 }, userId).messages;
  check(
    'imported messages keep their original timestamp',
    importedHistory.some(
      (message) => message.content === 'the first ever message' && message.createdAt === '2024-01-01T10:00:00.000Z',
    ),
  );
  check(
    'an imported reply links to its parent',
    importedHistory.find((message) => message.content === 'and a reply')?.replyTo?.content === 'the first ever message',
  );
  check('importing again adds nothing', (await bridge.importChannel(channelId)) === 0);

  // 7e. Reactions flow back in, and are attributed to a ghost user.
  const targetDiscordId = findBridgeMessageByHarmonyId(db.sqlite, target.id)?.discord_message_id;
  const reactionsOut = transport.state.reactions.length;
  transport.emitReactionAdd({
    messageId: targetDiscordId,
    channelId: '111',
    userId: '777',
    userName: 'Discord Rhea',
    emoji: '🎉',
    emojiId: null,
  });
  await sleep(50);
  const reacted = messages.history(channelId, { limit: 50 }, userId).messages.find((m) => m.id === target.id);
  check(
    'a discord reaction lands in harmony',
    reacted?.reactions.some((reaction) => reaction.emoji === '🎉' && reaction.count === 1) === true,
  );
  check('inbound reactions are not mirrored back', transport.state.reactions.length === reactionsOut);

  transport.emitReactionAdd({
    messageId: targetDiscordId,
    channelId: '111',
    userId: '777',
    userName: 'Discord Rhea',
    emoji: 'YES',
    emojiId: '700',
  });
  await sleep(50);
  const customReacted = messages.history(channelId, { limit: 50 }, userId).messages.find((m) => m.id === target.id);
  check(
    'a discord custom reaction maps to the harmony emoji',
    customReacted?.reactions.some((reaction) => reaction.emoji === ':YES:' && reaction.emojiId === 'emoji-yes') ===
      true,
  );

  transport.emitReactionRemove({
    messageId: targetDiscordId,
    channelId: '111',
    userId: '777',
    userName: 'Discord Rhea',
    emoji: '🎉',
    emojiId: null,
  });
  await sleep(50);
  const unreacted = messages.history(channelId, { limit: 50 }, userId).messages.find((m) => m.id === target.id);
  check('a removed discord reaction disappears', unreacted?.reactions.some((r) => r.emoji === '🎉') === false);

  // 7f. Custom emoji are translated by name in both directions.
  messages.create(auth, channelId, 'look :YES: and :NOPE:', [], null);
  await sleep(50);
  const emojiMirror = transport.state.mirrors.at(-1);
  check(
    'a known custom emoji is translated for discord',
    emojiMirror?.content.includes('<:YES:700>') === true,
    String(emojiMirror?.content),
  );
  check(
    'an unknown custom emoji is left as text',
    emojiMirror?.content.includes(':NOPE:') === true,
    String(emojiMirror?.content),
  );

  transport.emit({
    id: 'd5',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'hi <a:YES:700> and <:LATER:701> there',
    attachments: [],
    fromBot: false,
  });
  await sleep(50);
  check(
    'discord emoji tags become shortcodes',
    messages
      .history(channelId, { limit: 50 }, userId)
      .messages.some((m) => m.content === 'hi :YES: and :LATER: there'),
  );

  // 7g. Discord mentions become Harmony mentions, creating stand-ins as needed.
  transport.emit({
    id: 'd6',
    channelId: '111',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    mentions: [{ id: '555', name: 'Rhea' }],
    content: 'hello <@555> and <@!666>',
    attachments: [],
    fromBot: false,
  });
  await sleep(50);
  const mentionMessage = messages
    .history(channelId, { limit: 50 }, userId)
    .messages.find((m) => m.content.startsWith('hello '));
  check(
    'a discord mention becomes a harmony mention',
    mentionMessage?.content === 'hello @discord_555 and <@!666>',
    String(mentionMessage?.content),
  );
  check(
    'a mentioned discord user becomes a ghost account',
    findUserByDiscordId(db.sqlite, '555')?.display_name === 'Rhea',
  );

  // 7h. A mention of a bridged user pings them on Discord; a native Harmony
  // user is left as plain text.
  messages.create(auth, channelId, 'hi @discord_555 and @alice', [], null);
  await sleep(50);
  const mentionMirror = transport.state.mirrors.at(-1);
  check(
    'a bridged mention becomes a discord ping',
    mentionMirror?.content === 'hi <@555> and @alice',
    String(mentionMirror?.content),
  );
  check(
    'only the bridged user may be notified',
    mentionMirror?.allowedUserMentions?.join(',') === '555',
    String(mentionMirror?.allowedUserMentions),
  );

  // 8. Bots and webhooks never get ingested.
  const before = messages.history(channelId, { limit: 100 }, userId).messages.length;
  transport.emit({
    id: 'd3',
    channelId: '111',
    authorId: 'wh',
    authorName: 'Harmony',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'echo',
    attachments: [],
    fromBot: true,
  });
  await sleep(50);
  check('bot/webhook messages are ignored', messages.history(channelId, { limit: 100 }, userId).messages.length === before);

  // 9. Unmapped Discord channels are ignored.
  transport.emit({
    id: 'd4',
    channelId: '222',
    authorId: '999',
    authorName: 'Discord Sam',
    authorAvatarUrl: null,
    replyToDiscordId: null,
    content: 'elsewhere',
    attachments: [],
    fromBot: false,
  });
  await sleep(50);
  check('unmapped discord channels are ignored', messages.history(channelId, { limit: 100 }, userId).messages.length === before);

  // 10. The admin test message surfaces problems clearly.
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
    requiredRoleId: null,
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

  // 11. Discord emoji import. YES already exists from the reaction test above, so
  // it must be skipped; wave is new; X is too short for a Harmony emoji name.
  const emojiService = createEmojiService(db.sqlite, config);
  const emojiImport = createEmojiImportService({ emojis: emojiService, bridge, log: () => {} });
  transport.state.downloadBytes = png;
  transport.state.guildEmojis = [
    { id: '700', name: 'YES', animated: false },
    { id: '730', name: 'wave', animated: false },
    { id: '731', name: 'X', animated: false },
  ];

  const preview = await emojiImport.discordEmojis();
  check(
    'the emoji preview names the guild',
    preview.guildName === 'Test Guild' && preview.emojis.length === 3,
  );
  check(
    'the preview marks an emoji Harmony already has',
    preview.emojis.find((emoji) => emoji.name === 'YES')?.imported === true &&
      preview.emojis.find((emoji) => emoji.name === 'wave')?.imported === false,
  );

  const firstImport = await emojiImport.importMissing(auth);
  check('a new guild emoji is imported', firstImport.imported.length === 1 && firstImport.imported[0].name === 'wave');
  check('an existing emoji is skipped', firstImport.skipped === 1);
  check('an unusable discord name is counted as failed', firstImport.failed === 1);
  check(
    'the emoji bytes come from the discord cdn as png',
    transport.state.downloads.at(-1) === 'https://cdn.discordapp.com/emojis/730.png',
  );
  check('the imported emoji is stored', emojiService.list().some((emoji) => emoji.name === 'wave'));

  const secondImport = await emojiImport.importMissing(auth);
  check(
    'importing again skips everything already present',
    secondImport.imported.length === 0 && secondImport.skipped === 2 && secondImport.failed === 1,
  );

  const animated = await bridge.downloadGuildEmoji('740', true);
  check(
    'an animated emoji is fetched as a gif',
    animated.contentType === 'image/gif' &&
      transport.state.downloads.at(-1) === 'https://cdn.discordapp.com/emojis/740.gif',
  );

  // 12. Discord channel import. The channel for '111' is already bridged above,
  // so it is skipped; '222' is new and lands in a fresh 'General' category;
  // '333' is new and uncategorised, so it stays at the top level.
  const channelImport = createChannelImportService({ sqlite: db.sqlite, bridge, hub, log: () => {} });
  transport.state.recentMessages = [];

  const channelPreview = await channelImport.discordChannels();
  const previewChannels = channelPreview.groups.flatMap((group) => group.channels);
  check(
    'the channel preview names the guild and groups channels',
    channelPreview.guildName === 'Test Guild' && channelPreview.groups.length === 2,
  );
  check(
    'the channel preview marks an already bridged channel',
    previewChannels.find((channel) => channel.id === '111')?.bridged === true &&
      previewChannels.find((channel) => channel.id === '222')?.bridged === false,
  );
  check(
    'an uncategorised discord channel is grouped on its own',
    channelPreview.groups.find((group) => group.categoryName === null)?.channels.length === 1,
  );

  const channelImportResult = await channelImport.importMissing();
  check('new discord channels are imported', channelImportResult.imported === 2);
  check('an already bridged channel is skipped', channelImportResult.skipped === 1);
  check('the discord category is recreated', channelImportResult.categoriesCreated === 1);
  check(
    'the imported channels are bridged to discord',
    ['222', '333'].every((id) => listChannels(db.sqlite).some((channel) => channel.discord_channel_id === id)),
  );
  check(
    'the imported channel sits in its discord category',
    listCategories(db.sqlite).some((category) => category.name === 'General'),
  );

  const channelImportAgain = await channelImport.importMissing();
  check(
    'importing channels again skips everything',
    channelImportAgain.imported === 0 && channelImportAgain.skipped === 3 && channelImportAgain.categoriesCreated === 0,
  );

  // 13. Disabling stops the transport.
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
