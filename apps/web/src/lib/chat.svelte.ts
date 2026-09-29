import type {
  Category,
  Channel,
  Message,
  Reaction,
  ReactionsClearPayload,
  ReactionUpdatePayload,
} from '@harmony/shared';
import { api } from './api';
import { emojis } from './emojis.svelte';
import { session } from './session.svelte';
import { GatewayClient, type GatewayFrame } from './gateway';

/** Merges a single reaction event into a message's reaction list. */
function applyReactionDelta(
  reactions: Reaction[],
  payload: ReactionUpdatePayload,
  myId: string | undefined,
  mode: 'add' | 'remove',
): Reaction[] {
  const index = reactions.findIndex((reaction) => reaction.emoji === payload.emoji);
  const mine = payload.userId === myId;

  if (mode === 'add') {
    if (index === -1) {
      if (payload.count <= 0) return reactions;
      return [
        ...reactions,
        { emoji: payload.emoji, emojiId: payload.emojiId, count: payload.count, me: mine },
      ];
    }
    const next = reactions.slice();
    next[index] = { ...next[index], count: payload.count, me: mine ? true : next[index].me };
    return next;
  }

  if (index === -1) return reactions;
  if (payload.count <= 0) return reactions.filter((_, i) => i !== index);
  const next = reactions.slice();
  next[index] = { ...next[index], count: payload.count, me: mine ? false : next[index].me };
  return next;
}

/** Reactive state for the channel list and the currently open conversation. */
class ChatStore {
  categories = $state<Category[]>([]);
  channels = $state<Channel[]>([]);
  activeChannelId = $state<string | null>(null);
  messages = $state<Message[]>([]);
  loading = $state(false);
  /** The message the composer is currently replying to, if any. */
  replyTarget = $state<Message | null>(null);

  #gateway = new GatewayClient(GatewayClient.defaultUrl());
  #started = false;

  get activeChannel(): Channel | null {
    return this.channels.find((channel) => channel.id === this.activeChannelId) ?? null;
  }

  channelsIn(categoryId: string | null): Channel[] {
    return this.channels.filter((channel) => channel.categoryId === categoryId);
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#gateway.onEvent((frame) => this.#handleEvent(frame));
    await this.loadChannels();
    await emojis.load();
    this.#gateway.connect();
  }

  stop(): void {
    this.#started = false;
    this.#gateway.close();
    this.categories = [];
    this.channels = [];
    this.messages = [];
    this.activeChannelId = null;
    this.replyTarget = null;
  }

  async loadChannels(): Promise<void> {
    const data = await api<{ categories: Category[]; channels: Channel[] }>('/channels');
    this.categories = data.categories;
    this.channels = data.channels;

    // Keep the current selection if it still exists, otherwise pick the first.
    const stillExists = this.channels.some((channel) => channel.id === this.activeChannelId);
    if (!stillExists) await this.selectChannel(this.channels[0]?.id ?? null);
  }

  async selectChannel(channelId: string | null): Promise<void> {
    this.activeChannelId = channelId;
    this.messages = [];
    this.replyTarget = null;
    if (channelId) await this.loadHistory(channelId);
  }

  async loadHistory(channelId: string): Promise<void> {
    this.loading = true;
    try {
      const data = await api<{ messages: Message[] }>(`/channels/${channelId}/messages`);
      if (channelId === this.activeChannelId) this.messages = data.messages;
    } finally {
      this.loading = false;
    }
  }

  async sendMessage(content: string, attachmentIds: string[] = [], replyToId: string | null = null): Promise<void> {
    const channelId = this.activeChannelId;
    if (!channelId) return;
    // The message comes back over the gateway as MESSAGE_CREATE, so we don't append it here.
    await api(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        replyToId: replyToId ?? undefined,
      }),
    });
  }

  /** Adds or removes the current user's reaction; the gateway echoes the result. */
  async toggleReaction(messageId: string, emoji: string, emojiId: string | null): Promise<void> {
    await api(`/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji, emojiId: emojiId ?? undefined }),
    });
  }

  #handleEvent(frame: GatewayFrame): void {
    switch (frame.t) {
      case 'MESSAGE_CREATE': {
        const message = frame.d as Message;
        if (message.channelId === this.activeChannelId) this.messages = [...this.messages, message];
        break;
      }
      case 'MESSAGE_UPDATE': {
        const message = frame.d as Message;
        if (message.channelId === this.activeChannelId) {
          // Reactions are kept in sync by their own events, and an edit carries a
          // viewer-specific `me`, so never let it clobber what we already have.
          this.messages = this.messages.map((existing) =>
            existing.id === message.id ? { ...message, reactions: existing.reactions } : existing,
          );
        }
        break;
      }
      case 'MESSAGE_REACTION_ADD':
      case 'MESSAGE_REACTION_REMOVE': {
        const payload = frame.d as ReactionUpdatePayload;
        if (payload.channelId !== this.activeChannelId) break;
        const mode = frame.t === 'MESSAGE_REACTION_ADD' ? 'add' : 'remove';
        this.messages = this.messages.map((message) =>
          message.id === payload.messageId
            ? { ...message, reactions: applyReactionDelta(message.reactions, payload, session.user?.id, mode) }
            : message,
        );
        break;
      }
      case 'MESSAGE_REACTIONS_CLEAR': {
        const payload = frame.d as ReactionsClearPayload;
        if (payload.channelId !== this.activeChannelId) break;
        this.messages = this.messages.map((message) =>
          message.id === payload.messageId
            ? { ...message, reactions: message.reactions.filter((r) => r.emoji !== payload.emoji) }
            : message,
        );
        break;
      }
      case 'MESSAGE_DELETE': {
        const payload = frame.d as { id: string; channelId: string };
        if (payload.channelId === this.activeChannelId) {
          this.messages = this.messages.filter((message) => message.id !== payload.id);
        }
        break;
      }
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'CHANNEL_DELETE':
      case 'CATEGORY_CREATE':
      case 'CATEGORY_UPDATE':
      case 'CATEGORY_DELETE':
        void this.loadChannels();
        break;
      case 'ROLE_CREATE':
      case 'ROLE_UPDATE':
      case 'ROLE_DELETE':
      case 'MEMBER_UPDATE':
        // Username colours may have changed; refresh the open channel.
        if (this.activeChannelId) void this.loadHistory(this.activeChannelId);
        break;
      case 'EMOJI_CREATE':
      case 'EMOJI_DELETE':
        void emojis.load();
        break;
      case 'RETENTION_APPLIED':
        // Content may have been pruned from the open channel.
        if (this.activeChannelId) void this.loadHistory(this.activeChannelId);
        break;
    }
  }
}

export const chat = new ChatStore();
