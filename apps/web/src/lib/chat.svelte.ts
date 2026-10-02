import type {
  Category,
  Channel,
  ChannelListResponse,
  MeResponse,
  Message,
  Reaction,
  ReactionsClearPayload,
  ReactionUpdatePayload,
  PresenceUpdatePayload,
  TypingStartPayload,
  User,
} from '@harmony/shared';
import { ApiError, api } from './api';
import { emojis } from './emojis.svelte';
import { gifs } from './gifs.svelte';
import { mentionsUser, mergeLatest } from './messages';
import { members } from './members.svelte';
import { roster } from './roster.svelte';
import { session } from './session.svelte';
import { playNotification } from './sounds';
import { GatewayClient, type GatewayFrame } from './gateway';

/** How many messages one history page holds, for both directions. */
const historyPageSize = 50;

/** How long a typing indicator stays up without a refresh from its author. */
const typingTtlMs = 8000;
/** How often expired typing indicators are cleared away. */
const typingSweepMs = 2000;
/** How long a read marker waits when it rides on incoming messages. */
const readDebounceMs = 1000;

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
  /** People typing in the open channel, each with when their notice expires. */
  typingUsers = $state<Array<{ user: User; expiresAt: number }>>([]);
  /** The message a search result landed on, flashed briefly. */
  highlightedId = $state<string | null>(null);
  /**
   * Channels with something this member has not read. It is per member, and the
   * server is what persists it, so it survives a reload and follows them between
   * devices.
   */
  unreadChannelIds = $state<string[]>([]);
  unread = $derived(new Set(this.unreadChannelIds));
  /**
   * Channels holding an unread mention or reply for this member, which is what
   * draws the red mark beside a channel. Like `unreadChannelIds` it is per
   * member and kept by the server, and a channel drops off it exactly when it is
   * read.
   */
  mentionChannelIds = $state<string[]>([]);
  mention = $derived(new Set(this.mentionChannelIds));
  /**
   * Bumped when a jump wants the message list to scroll to its end. An explicit
   * signal because replacing the list looks like a prepend to the view, which it
   * deliberately refuses to scroll for.
   */
  scrollSignal = $state(0);

  #gateway = new GatewayClient(GatewayClient.defaultUrl());
  #started = false;
  /** Whether a READY has already been seen, to tell a first connect from a reconnect. */
  #connected = false;
  #typingTimer: ReturnType<typeof setInterval> | null = null;
  #highlightTimer: ReturnType<typeof setTimeout> | null = null;
  /** Channels whose read marker is waiting to be sent. */
  #readPending = new Set<string>();
  #readTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards the channel-list refresh that a denied channel triggers. */
  #healing = false;

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
    document.addEventListener('visibilitychange', this.#onVisibility);
    await this.loadChannels();
    await emojis.load();
    await gifs.loadFavorites();
    await members.load();
    await roster.load();
    this.#gateway.connect();
  }

  stop(): void {
    this.#started = false;
    this.#connected = false;
    this.#gateway.close();
    document.removeEventListener('visibilitychange', this.#onVisibility);
    this.categories = [];
    this.channels = [];
    this.messages = [];
    this.activeChannelId = null;
    this.replyTarget = null;
    this.hasMore = false;
    this.loadingOlder = false;
    this.highlightedId = null;
    this.unreadChannelIds = [];
    this.mentionChannelIds = [];
    if (this.#highlightTimer) clearTimeout(this.#highlightTimer);
    this.#highlightTimer = null;
    if (this.#readTimer) clearTimeout(this.#readTimer);
    this.#readTimer = null;
    this.#readPending.clear();
    this.#clearTyping();
    roster.reset();
  }

  /**
   * Brings the client back in step after the app was away, such as a phone that
   * backgrounded it and was reopened. Nothing arrives while the page is hidden, so
   * the socket is re-established without waiting and everything that can have
   * changed meanwhile is refetched.
   *
   * The open channel keeps the pages it has already loaded: only the newest page
   * is folded in, so a reader who had scrolled up is not yanked to the bottom,
   * while someone sitting at the newest message simply sees it follow along.
   */
  async resync(): Promise<void> {
    this.#gateway.ensureConnected();

    // Resuming on a phone often means resuming with no usable network for a
    // moment, so the one refresh that would throw is caught rather than left to
    // surface as an unhandled rejection. The rest keep whatever they already have.
    void this.loadChannels().catch(() => {});
    void roster.load();
    void members.load();
    void emojis.load();
    void gifs.loadFavorites();
    void this.#refreshSession();

    const channelId = this.activeChannelId;
    if (!channelId) return;

    try {
      const page = await this.#fetchHistory(channelId);
      // A channel switch while this was in flight must not splice a page from
      // the wrong channel into the open one.
      if (channelId !== this.activeChannelId) return;
      this.messages = mergeLatest(this.messages, page);
    } catch {
      // Still offline, or the channel was locked away while we were gone. The
      // channel list refresh above is what deals with the second case.
    }
  }

  async loadChannels(): Promise<void> {
    const data = await api<ChannelListResponse>('/channels');
    this.categories = data.categories;
    this.channels = data.channels;
    this.unreadChannelIds = data.unreadChannelIds;
    this.mentionChannelIds = data.mentionChannelIds;

    // Keep the current selection if it still exists. Otherwise open the
    // admin-configured default channel, falling back to the first channel and
    // finally to nothing when the instance has no channels at all.
    const stillExists = this.channels.some((channel) => channel.id === this.activeChannelId);
    if (!stillExists) {
      const preferred = this.channels.find((channel) => channel.id === data.defaultChannelId)?.id;
      await this.selectChannel(preferred ?? this.channels[0]?.id ?? null);
    } else if (this.activeChannelId) {
      // A refresh can arrive with the open channel marked unread, for instance
      // after a role change brought it back into view. It is open, so it is read.
      this.#markRead(this.activeChannelId, false);
    }
  }

  /**
   * Says the open channel has been read: it stops being marked here at once, and
   * the server is told, which is what makes it stay read across a reload.
   *
   * The telling is coalesced when it rides on incoming messages, since a busy
   * channel would otherwise mean a request per message, and the same request twice
   * within a moment is the same request.
   */
  #markRead(channelId: string, soon: boolean): void {
    if (this.unread.has(channelId)) {
      this.unreadChannelIds = this.unreadChannelIds.filter((id) => id !== channelId);
    }
    // Reading a channel reads the mentions in it too, so the mark goes with it.
    if (this.mention.has(channelId)) {
      this.mentionChannelIds = this.mentionChannelIds.filter((id) => id !== channelId);
    }
    this.#readPending.add(channelId);

    if (this.#readTimer) {
      clearTimeout(this.#readTimer);
      this.#readTimer = null;
    }
    if (soon) {
      this.#readTimer = setTimeout(() => {
        this.#readTimer = null;
        this.#flushRead();
      }, readDebounceMs);
    } else {
      this.#flushRead();
    }
  }

  #flushRead(): void {
    const ids = [...this.#readPending];
    this.#readPending.clear();
    for (const id of ids) {
      void api(`/channels/${id}/read`, { method: 'POST' }).catch(() => {
        // Best effort: opening the channel again marks it once more.
      });
    }
  }

  /**
   * Coming back to a tab with a channel open means its messages have been seen,
   * so it stops being marked. Anything that arrived while the tab was out of
   * sight stayed marked until now.
   */
  #onVisibility = (): void => {
    if (document.visibilityState === 'visible' && this.activeChannelId) {
      this.#markRead(this.activeChannelId, true);
    }
  };

  async selectChannel(channelId: string | null): Promise<void> {
    this.activeChannelId = channelId;
    this.messages = [];
    this.hasMore = false;
    this.loadingOlder = false;
    this.replyTarget = null;
    this.highlightedId = null;
    if (channelId) this.#markRead(channelId, false);
    this.#clearTyping();
    if (channelId) await this.loadHistory(channelId);
  }

  /** One page of a channel's history, ending just before the cursor when given. */
  async #fetchHistory(channelId: string, cursor?: { before: string; beforeId: string }): Promise<Message[]> {
    const query = new URLSearchParams({ limit: String(historyPageSize) });
    if (cursor) {
      query.set('before', cursor.before);
      query.set('beforeId', cursor.beforeId);
    }
    const data = await api<{ messages: Message[] }>(`/channels/${channelId}/messages?${query}`);
    return data.messages;
  }

  async loadHistory(channelId: string): Promise<void> {
    this.loading = true;
    try {
      const messages = await this.#fetchHistory(channelId);
      if (channelId === this.activeChannelId) {
        this.messages = messages;
        this.hasMore = messages.length >= historyPageSize;
      }
    } catch (cause) {
      // Access to a locked channel can be taken away while it is open. Refresh the
      // list, which drops it and opens one we can still see.
      if (
        cause instanceof ApiError &&
        (cause.status === 403 || cause.status === 404) &&
        channelId === this.activeChannelId &&
        !this.#healing
      ) {
        this.#healing = true;
        try {
          await this.loadChannels();
        } finally {
          this.#healing = false;
        }
      }
    } finally {
      this.loading = false;
    }
  }

  /**
   * Opens a channel at a particular message, for a search result. The page holds
   * the messages just before it and the message itself is put on the end, so it
   * appears with its context above it rather than alone.
   */
  async jumpToMessage(channelId: string, message: Message): Promise<void> {
    this.activeChannelId = channelId;
    this.messages = [];
    this.hasMore = false;
    this.loadingOlder = false;
    this.replyTarget = null;
    this.highlightedId = null;
    this.#clearTyping();
    // Jumping into a channel is opening it, so it counts as read: this is what
    // clears a search result's channel and the inbox entry that led here.
    this.#markRead(channelId, false);

    this.loading = true;
    try {
      const page = await this.#fetchHistory(channelId, {
        before: message.createdAt,
        beforeId: message.id,
      });
      if (channelId !== this.activeChannelId) return;
      this.messages = [...page, message];
      this.hasMore = page.length >= historyPageSize;
    } catch {
      // A message that vanished between searching and jumping is not worth an
      // error: the channel still opens, just at its newest page.
      await this.loadHistory(channelId);
    } finally {
      this.loading = false;
    }

    this.#highlight(message.id);
    // The jumped-to message is the last one loaded, so bring it into view.
    this.scrollSignal += 1;
  }

  /** Flashes a message for a few seconds, so a jump is obvious. */
  #highlight(messageId: string): void {
    this.highlightedId = messageId;
    if (this.#highlightTimer) clearTimeout(this.#highlightTimer);
    this.#highlightTimer = setTimeout(() => {
      this.highlightedId = null;
      this.#highlightTimer = null;
    }, 3000);
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
      const page = await this.#fetchHistory(channelId, { before: oldest.createdAt, beforeId: oldest.id });
      // A channel switch while this was in flight must not splice in old history.
      if (channelId !== this.activeChannelId) return;
      this.messages = [...page, ...this.messages];
      this.hasMore = page.length >= historyPageSize;
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

  /** Tells the server we are typing in the open channel. Best effort. */
  async sendTyping(): Promise<void> {
    const channelId = this.activeChannelId;
    if (!channelId) return;
    try {
      await api(`/channels/${channelId}/typing`, { method: 'POST' });
    } catch {
      // A typing ping is never important enough to surface an error.
    }
  }

  /** Adds or refreshes one person's typing indicator. */
  #noteTyping(user: User): void {
    const expiresAt = Date.now() + typingTtlMs;
    const others = this.typingUsers.filter((entry) => entry.user.id !== user.id);
    this.typingUsers = [...others, { user, expiresAt }];
    this.#startTypingSweep();
  }

  #clearTyping(): void {
    this.typingUsers = [];
    this.#stopTypingSweep();
  }

  #startTypingSweep(): void {
    if (this.#typingTimer) return;
    this.#typingTimer = setInterval(() => {
      const now = Date.now();
      const live = this.typingUsers.filter((entry) => entry.expiresAt > now);
      if (live.length !== this.typingUsers.length) this.typingUsers = live;
      if (live.length === 0) this.#stopTypingSweep();
    }, typingSweepMs);
  }

  #stopTypingSweep(): void {
    if (!this.#typingTimer) return;
    clearInterval(this.#typingTimer);
    this.#typingTimer = null;
  }

  async #refreshSession(): Promise<void> {
    try {
      const me = await api<MeResponse>('/auth/me');
      session.user = me.user;
      session.permissions = me.permissions;
    } catch (cause) {
      // The session is gone: kicked, banned or expired. A request that never
      // reached the server is a different matter, and must not sign anyone out.
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
        session.user = null;
        session.permissions = '0';
      }
    }
  }

  /**
   * Whether a message is aimed at the signed-in member, by a reply or by name.
   * It is the same question the sound and the channel mark both ask, so the two
   * can never disagree about what counts as a mention.
   */
  #mentionsMe(message: Message): boolean {
    const me = session.user;
    if (!me || message.author?.id === me.id) return false;
    return mentionsUser(message, me.id, (name) => members.byUsername.get(name.toLowerCase()));
  }

  /**
   * Plays the sound a new message deserves, if the member wants one. Nothing is
   * played for their own messages, and nothing ever leaves the page: this is the
   * in-app sound, not a device notification.
   */
  #notify(message: Message): void {
    const me = session.user;
    if (!me || message.author?.id === me.id) return;

    // A mention is aimed at this person wherever they happen to be looking, so
    // it is worth the louder sound even from another channel.
    if (this.#mentionsMe(message)) {
      if (me.notifyMajor) playNotification('major');
      return;
    }

    // Anything else only counts in the channel being read. Otherwise a busy
    // instance would chirp once per message in every channel at once.
    if (message.channelId === this.activeChannelId && me.notifyMinor) playNotification('minor');
  }

  #handleEvent(frame: GatewayFrame): void {
    switch (frame.t) {
      case 'MESSAGE_CREATE': {
        const message = frame.d as Message;
        this.#notify(message);

        const active = message.channelId === this.activeChannelId;
        // An open channel in a tab nobody is looking at has not really been read,
        // so only the visible case counts. Coming back to the tab readies it again.
        if (active && document.visibilityState === 'visible') {
          this.#markRead(message.channelId, true);
        } else if (!this.unread.has(message.channelId)) {
          this.unreadChannelIds = [...this.unreadChannelIds, message.channelId];
        }

        // A mention aims at this member wherever they are, so it earns the red
        // mark even in a channel they are not looking at. Reading it clears the
        // mark, so the open-and-visible case is left to #markRead above.
        if (
          !(active && document.visibilityState === 'visible') &&
          this.#mentionsMe(message) &&
          !this.mention.has(message.channelId)
        ) {
          this.mentionChannelIds = [...this.mentionChannelIds, message.channelId];
        }

        if (!active) break;
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
      case 'TYPING_START': {
        const payload = frame.d as TypingStartPayload;
        if (payload.channelId !== this.activeChannelId) break;
        // Never echo our own typing, and respect a viewer who turned them off.
        if (payload.user.id === session.user?.id) break;
        if (!session.user?.showTyping) break;
        this.#noteTyping(payload.user);
        break;
      }
      case 'PRESENCE_UPDATE':
        roster.applyPresence(frame.d as PresenceUpdatePayload);
        break;
      case 'READY':
        // A reconnect means the socket was away. Anything the bridge backfilled
        // meanwhile is delivered as fetched history rather than live events, so
        // pull what changed instead of waiting for the next channel switch.
        if (this.#connected) {
          void this.resync();
          break;
        }
        this.#connected = true;
        // Closes the gap between the first roster load and the gateway connecting.
        void roster.load();
        break;
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
        // Roles decide username colors, member list grouping and which channels
        // are locked, so refresh the channel list, the open channel and the roster.
        void this.loadChannels();
        if (this.activeChannelId) void this.loadHistory(this.activeChannelId);
        void roster.load();
        break;
      case 'MEMBER_UPDATE': {
        const payload = frame.d as { userId: string };
        // The roster and mention list may have changed, and if it was us the
        // change could be our own timeout or a role that unlocks channels.
        void members.load();
        void roster.load();
        if (payload.userId === session.user?.id) {
          void this.loadChannels();
          void this.#refreshSession();
        }
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
