import {
  type HostVoiceMember,
  type HostVoiceMessage,
  type HostVoiceSelf,
  subscribeHostVoiceState,
  voiceHost,
  webVoiceDisabled,
} from './voice-mode';

const restingSelf = (): HostVoiceSelf => ({ muted: false, deafened: false, sharing: false });

/**
 * The call state the native shell pushes back while it runs voice itself.
 *
 * The web client never owns this call — the shell holds the microphone and the
 * voice seat — so this store only mirrors what the shell reports, which is what
 * the sidebar's voice row needs to read as connected, muted, or left. It is
 * empty (`channelId` null) in a plain browser, and the row falls back to the
 * web client's own `voice` store there.
 */
class HostVoiceStore {
  /** The channel the shell's native call is in, or null when there is none. */
  channelId = $state<string | null>(null);
  channelName = $state<string | null>(null);
  self = $state<HostVoiceSelf>(restingSelf());
  members = $state<HostVoiceMember[]>([]);
  #unsubscribe: (() => void) | null = null;

  /** Whether the shell is running a call right now. */
  get connected(): boolean {
    return this.channelId !== null;
  }

  /** Starts listening for the shell's call state. Idempotent. */
  start(): void {
    if (this.#unsubscribe) return;
    // Only a voice-off shell pushes state, so a normal browser wires nothing.
    if (!webVoiceDisabled() && !voiceHost()) return;
    this.#unsubscribe = subscribeHostVoiceState((message) => this.apply(message));
  }

  /** Applies one host message; a `left` clears the call. */
  apply(message: HostVoiceMessage): void {
    if (message.type === 'left') {
      this.clear();
      return;
    }
    this.channelId = message.channelId;
    this.channelName = message.channelName;
    this.self = message.self;
    this.members = message.members;
  }

  clear(): void {
    this.channelId = null;
    this.channelName = null;
    this.self = restingSelf();
    this.members = [];
  }

  /** Stops listening and forgets the call, which a logout does. */
  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.clear();
  }
}

export const hostVoice = new HostVoiceStore();
