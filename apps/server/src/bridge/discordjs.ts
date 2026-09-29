import { ChannelType, Client, Events, GatewayIntentBits, type TextChannel } from 'discord.js';
import type { BridgeStatus, DiscordChannelOption } from '@harmony/shared';
import type {
  DiscordIncomingMessage,
  DiscordTransport,
  MirrorInput,
  MirrorResult,
  WebhookRef,
} from './transport.ts';

/** Discord rejects content longer than this. */
const MAX_DISCORD_CONTENT = 2000;
const MAX_DISCORD_USERNAME = 80;

export function createDiscordTransport(
  token: string,
  log: (message: string, detail?: unknown) => void,
): DiscordTransport {
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
    log('discord bridge connected', { botTag: status.botTag, guildName: status.guildName });
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

  return {
    async start() {
      try {
        await client.login(token);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status = { ready: false, botTag: null, guildName: null, error: message };
        log('discord login failed', message);
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
      const channel = await client.channels.fetch(input.discordChannelId);
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new Error(`Discord channel ${input.discordChannelId} is not a text channel`);
      }

      let webhook: WebhookRef | null = input.webhook;
      if (!webhook) {
        const created = await (channel as TextChannel).createWebhook({ name: 'Harmony' });
        webhook = { id: created.id, token: created.token ?? '' };
      }

      // Post straight to the webhook endpoint so we can override the name, and
      // suppress all mentions so mirrored content can never ping anyone.
      const sent = (await client.rest.post(`/webhooks/${webhook.id}/${webhook.token}`, {
        auth: false,
        query: new URLSearchParams({ wait: 'true' }),
        body: {
          content: input.content.slice(0, MAX_DISCORD_CONTENT),
          username: input.username.slice(0, MAX_DISCORD_USERNAME),
          allowed_mentions: { parse: [] },
        },
      })) as { id: string };

      return { messageId: sent.id, webhook };
    },
  };
}
