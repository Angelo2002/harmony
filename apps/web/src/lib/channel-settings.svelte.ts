import {
  nextMuteExpiry,
  resolveChannelSettings,
  type Channel,
  type ChannelNotificationSettings,
  type ChannelSettingsListResponse,
  type ResolvedChannelSettings,
  type UpdateChannelSettingsInput,
} from '@harmony/shared';
import { api } from './api';

/** The longest delay `setTimeout` honors; anything longer fires at once. */
const maxTimerMs = 2 ** 31 - 1;

/**
 * This member's mutes and notification levels for channels and categories.
 * The server keeps them, so they follow the member between devices, and a
 * change made on one device arrives on the others over the gateway.
 */
class ChannelSettingsStore {
  /** Stored settings by channel or category id. Anything absent is on the defaults. */
  byTarget = $state<Record<string, ChannelNotificationSettings>>({});
  /**
   * The clock the mutes are read against. It only moves when a mute is due to
   * lift, which is what makes an expired mute let go of a channel without a
   * reload: everything derived from it looks again at that moment.
   */
  now = $state(Date.now());

  #expiryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on each load and reset, so a slow reply cannot land over newer state. */
  #loadGeneration = 0;

  async load(): Promise<void> {
    const generation = ++this.#loadGeneration;
    const data = await api<ChannelSettingsListResponse>('/users/@me/channel-settings');
    // A newer load started, or the store was reset, while this one was in
    // flight; that state is newer, so drop this stale snapshot.
    if (generation !== this.#loadGeneration) return;
    const loaded = Object.fromEntries(data.settings.map((settings) => [settings.targetId, settings]));
    // Merge under what is already held, so a change that arrived over the
    // gateway or came back from a PUT while the request was in flight is not
    // undone by a snapshot taken before it.
    this.byTarget = { ...loaded, ...this.byTarget };
    this.#tick();
  }

  reset(): void {
    // Invalidate any load still in flight so it cannot repopulate a logged-out store.
    this.#loadGeneration += 1;
    this.byTarget = {};
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;
  }

  /** Takes in settings the server sent back, whether to this session or another of ours. */
  apply(settings: ChannelNotificationSettings): void {
    this.byTarget = { ...this.byTarget, [settings.targetId]: settings };
    this.#tick();
  }

  /** Changes one channel's or category's settings. The response is the new state. */
  async update(targetId: string, input: UpdateChannelSettingsInput): Promise<void> {
    const settings = await api<ChannelNotificationSettings>(`/users/@me/channel-settings/${targetId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    this.apply(settings);
  }

  /** How a channel behaves, with its category's settings folded in. */
  resolve(channel: Pick<Channel, 'id' | 'categoryId'>): ResolvedChannelSettings {
    const category = channel.categoryId === null ? undefined : this.byTarget[channel.categoryId];
    return resolveChannelSettings(this.byTarget[channel.id], category, this.now);
  }

  /** How a category itself is set, for its own menu and header. */
  resolveCategory(categoryId: string): ResolvedChannelSettings {
    return resolveChannelSettings(undefined, this.byTarget[categoryId], this.now);
  }

  /**
   * Moves the clock to now and sets one timer for the next mute due to lift.
   * Settings arrive already judged against the server's clock, so this only
   * has to notice the moment one of them runs out.
   */
  #tick(): void {
    this.now = Date.now();
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = null;

    const next = nextMuteExpiry(Object.values(this.byTarget), this.now);
    if (next === null) return;
    // A moment's grace so the mute has certainly ended by the time it is read.
    this.#expiryTimer = setTimeout(
      () => {
        this.#expiryTimer = null;
        this.#tick();
      },
      Math.min(next - this.now + 250, maxTimerMs),
    );
  }
}

export const channelSettings = new ChannelSettingsStore();
