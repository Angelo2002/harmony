import { ChannelType, Client, Events, GatewayIntentBits, type TextChannel } from 'discord.js';
import type { BridgeStatus, DiscordChannelOption } from '@harmony/shared';
import type {
  BridgeLogger,
  DiscordIncomingMessage,
  DiscordTransport,
  MirrorInput,
  MirrorResult,
  WebhookRef,
} from './transport.ts';

/** Discord rejects content longer than this. */
const MAX_DISCORD_CONTENT = 2000;
const MAX_DISCORD_USERNAME = 80;

export function createDiscordTransport(token: string, logger: BridgeLogger): DiscordTransport {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  const handlers: Array<(message: DiscordIncomingMessage) => void> = [];
  let status: BridgeStatus = { ready: false, botTag: null, guildName: null, error: null };

  client.once(Events.ClientReady, (ready) => {
    status = {
      ready: true,
      botTag: ready.user.tag,
      guildName: ready.guilds.cache.first()?.name ?? null,
      error: null,
    };
    logger.info('discord bridge connected', { botTag: status.botTag, guildName: status.guildName });
  });

  client.on(Events.MessageCreate, (message) => {
    const incoming: DiscordIncomingMessage = {
      id: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
      authorName: message.member?.displayName ?? message.author.displayName,
      content: message.content,
      // Webhook messages are ours; never echo them back.
      fromBot: message.author.bot || message.webhookId !== null,
    };
    for (const handler of handlers) handler(incoming);
  });

  function firstGuild() {
    return client.guilds.cache.first() ?? null;
  }

  /**
   * Returns a usable webhook, reusing the cached one when it still exists and
   * creating a replacement otherwise. Message overrides (username) only work on
   * webhooks, so one has to exist for the channel.
   */
  async function ensureWebhook(channel: TextChannel, cached: WebhookRef | null): Promise<WebhookRef> {
    if (cached?.id && cached.token) {
      try {
        await client.fetchWebhook(cached.id, cached.token);
        return cached;
      } catch {
        logger.debug('cached discord webhook is gone, creating a new one', { channelId: channel.id });
      }
    }

    try {
      const created = await channel.createWebhook({ name: 'Harmony' });
      if (!created.token) throw new Error('Discord did not return a webhook token');
      return { id: created.id, token: created.token };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not create a webhook in #${channel.name}. The bot needs the "Manage Webhooks" permission there. (${detail})`,
      );
    }
  }

  return {
    async start() {
      try {
        await client.login(token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status = { ready: false, botTag: null, guildName: null, error: message };
        logger.info('discord login failed', message);
      }
    },

    async stop() {
      try {
        await client.destroy();
      } catch {
        // Already torn down.
      }
      status = { ready: false, botTag: null, guildName: null, error: null };
    },

    status: () => status,

    async listTextChannels() {
      const guild = firstGuild();
      if (!guild) return { guildName: null, channels: [] };

      const fetched = await guild.channels.fetch();
      const channels: DiscordChannelOption[] = [];
      for (const channel of fetched.values()) {
        if (channel && channel.type === ChannelType.GuildText) {
          channels.push({ id: channel.id, name: channel.name });
        }
      }
      channels.sort((a, b) => a.name.localeCompare(b.name));
      return { guildName: guild.name, channels };
    },

    onMessage(handler) {
      handlers.push(handler);
    },

    async mirror(input: MirrorInput): Promise<MirrorResult> {
      logger.debug('mirroring to discord', { channelId: input.discordChannelId });

      const channel = await client.channels.fetch(input.discordChannelId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new Error(`Discord channel ${input.discordChannelId} is not a text channel the bot can see.`);
      }
      const textChannel = channel as TextChannel;

      const webhook = await ensureWebhook(textChannel, input.webhook);

      try {
        // Posting straight to the webhook endpoint is what discord.js's own
        // Webhook#send does, and is the only way to override the name.
        const sent = (await client.rest.post(`/webhooks/${webhook.id}/${webhook.token}`, {
          auth: false,
          query: new URLSearchParams({ wait: 'true' }),
          body: {
            content: input.content.slice(0, MAX_DISCORD_CONTENT),
            username: input.username.slice(0, MAX_DISCORD_USERNAME),
            // Never let mirrored content ping anyone.
            allowed_mentions: { parse: [] },
          },
        })) as { id: string };

        logger.debug('mirrored a message to discord', {
          channelId: input.discordChannelId,
          messageId: sent.id,
        });
        return { messageId: sent.id, webhook };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: number | string }).code;
        throw new Error(`Discord rejected the webhook message (${code ?? 'error'}): ${detail}`);
      }
    },
  };
}
