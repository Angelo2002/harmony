import type {
  Category,
  Channel,
  ChannelListResponse,
  MeResponse,
  Message,
  Reaction,
  ReactionsClearPayload,
  ReactionUpdatePayload,
} from '@harmony/shared';
import { api } from './api';
import { emojis } from './emojis.svelte';
import { members } from './members.svelte';
import { session } from './session.svelte';
import { GatewayClient, type GatewayFrame } from './gateway';

/** How many messages one history page holds, for both directions. */
const historyPageSize = 50;

/** Merges a single reaction event into a message's reaction list. */
function applyReactionDelta(
  reactions: Reaction[],
  payload: ReactionUpdatePayload,
  myId: string | undefined,
  mode: 'add' | 'remove',
): Reaction[] {
  const index = reactions.findIndex((reaction) => reaction.emoji === payload.emoji);
  const mine = payload.userId === myId;
  const existing = index === -1 ? undefined : reactions[index];

  if (mode === 'add') {
    if (!existing) {
      if (payload.count <= 0) return reactions;
      return [
        ...reactions,
        { emoji: payload.emoji, emojiId: payload.emojiId, count: payload.count, me: mine },
      ];
    }
    const next = reactions.slice();
    next[index] = { ...existing, count: payload.count, me: mine ? true : existing.me };
    return next;
  }

  if (!existing) return reactions;
  if (payload.count <= 0) return reactions.filter((_, i) => i !== index);
  const next = reactions.slice();
  next[index] = { ...existing, count: payload.count, me: mine ? false : existing.me };
  return next;
}

/** Reactive state for the channel list and the currently open conversation. */
class ChatStore {
  categories = $state<Category[]>([]);
  channels = $state<Channel[]>([]);
  activeChannelId = $state<string | null>(null);
  messages = $state<Message[]>([]);
  loading = $state(false);
  /** Whether older messages exist beyond the oldest one loaded. */
  hasMore = $state(false);
  loadingOlder = $state(false);
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
    await members.load();
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
    this.hasMore = false;
    this.loadingOlder = false;
  }

  async loadChannels(): Promise<void> {
    const data = await api<ChannelListResponse>('/channels');
    this.categories = data.categories;
    this.channels = data.channels;

    // Keep the current selection if it still exists. Otherwise open the
    // admin-configured default channel, falling back to the first channel and
    // finally to nothing when the instance has no channels at all.
    const stillExists = this.channels.some((channel) => channel.id === this.activeChannelId);
    if (!stillExists) {
      const preferred = this.channels.find((channel) => channel.id === data.defaultChannelId)?.id;
      await this.selectChannel(preferred ?? this.channels[0]?.id ?? null);
    }
  }

  async selectChannel(channelId: string | null): Promise<void> {
    this.activeChannelId = channelId;
    this.messages = [];
    this.hasMore = false;
    this.loadingOlder = false;
    this.replyTarget = null;
    if (channelId) await this.loadHistory(channelId);
  }

  async loadHistory(channelId: string): Promise<void> {
    this.loading = true;
    try {
      const data = await api<{ messages: Message[] }>(`/channels/${channelId}/messages?limit=${historyPageSize}`);
      if (channelId === this.activeChannelId) {
        this.messages = data.messages;
        this.hasMore = data.messages.length >= historyPageSize;
      }
    } finally {
      this.loading = false;
    }
  }

  /**
   * Fetches the page of messages just before the oldest one loaded and prepends
   * it. The cursor is the oldest message's timestamp together with its id, so a
   * burst of messages sharing a millisecond is never skipped.
   */
  async loadOlder(): Promise<void> {
    const channelId = this.activeChannelId;
    const oldest = this.messages[0];
    if (!channelId || !oldest || this.loadingOlder || !this.hasMore) return;

    this.loadingOlder = true;
    try {
      const query = new URLSearchParams({
        limit: String(historyPageSize),
        before: oldest.createdAt,
        beforeId: oldest.id,
      });
      const data = await api<{ messages: Message[] }>(`/channels/${channelId}/messages?${query}`);
      // A channel switch while this was in flight must not splice in old history.
      if (channelId !== this.activeChannelId) return;
      this.messages = [...data.messages, ...this.messages];
      this.hasMore = data.messages.length >= historyPageSize;
    } finally {
      this.loadingOlder = false;
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

  /** Edits a message's text; the gateway echoes the update. */
  async editMessage(messageId: string, content: string): Promise<void> {
    await api(`/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ content }) });
  }

  /** Deletes a message; the gateway echoes the removal. */
  async deleteMessage(messageId: string): Promise<void> {
    await api(`/messages/${messageId}`, { method: 'DELETE' });
  }

  async #refreshSession(): Promise<void> {
    try {
      const me = await api<MeResponse>('/auth/me');
      session.user = me.user;
      session.permissions = me.permissions;
    } catch {
      // The session is gone (kicked, banned or expired).
      session.user = null;
      session.permissions = '0';
    }
  }

  #handleEvent(frame: GatewayFrame): void {
    switch (frame.t) {
      case 'MESSAGE_CREATE': {
        const message = frame.d as Message;
        if (message.channelId !== this.activeChannelId) break;
        if (this.messages.some((existing) => existing.id === message.id)) break;
        // A history import can deliver older messages, so insert by timestamp
        // rather than always appending, keeping the list chronological.
        const next = [...this.messages];
        let index = next.length;
        while (index > 0) {
          const previous = next[index - 1];
          if (!previous || previous.createdAt <= message.createdAt) break;
          index--;
        }
        next.splice(index, 0, message);
        this.messages = next;
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
        // Username colours may have changed; refresh the open channel.
        if (this.activeChannelId) void this.loadHistory(this.activeChannelId);
        break;
      case 'MEMBER_UPDATE': {
        const payload = frame.d as { userId: string };
        // The roster and mention list may have changed, and if it was us the
        // change could be our own timeout, so refresh our profile too.
        void members.load();
        if (payload.userId === session.user?.id) void this.#refreshSession();
        if (this.activeChannelId) void this.loadHistory(this.activeChannelId);
        break;
      }
      case 'CLOSE': {
        const payload = frame.d as { code: number };
        // 4004 and 4005 mean the session is gone: logged out, kicked or banned.
        if (payload.code === 4004 || payload.code === 4005) {
          session.user = null;
          session.permissions = '0';
        }
        break;
      }
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
