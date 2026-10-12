/**
 * Whether the host app has taken voice over, so the web client must not join or
 * resume a call.
 *
 * The Android shell runs voice natively and already injects a document-start
 * script into the instance webview (the screen-share shim), so it can set
 * `window.__harmonyVoiceDisabled = true` before the app loads; opening the page
 * with `?voice=off` does the same. Either way the client keeps the rosters it
 * shows in the sidebar but never captures the microphone, which the native
 * client needs to itself — two capture streams fight, and the platform mutes one.
 *
 * Unset, this is false and everything behaves exactly as before.
 */
export function webVoiceDisabled(): boolean {
  const flag = (globalThis as { __harmonyVoiceDisabled?: unknown }).__harmonyVoiceDisabled;
  if (flag === true || flag === 'true' || flag === 'off') return true;
  const search = (globalThis as { location?: { search?: string } }).location?.search ?? '';
  return new URLSearchParams(search).get('voice') === 'off';
}

/** This member's own state in the host's native call, for the row's indicator. */
export interface HostVoiceSelf {
  muted: boolean;
  deafened: boolean;
  sharing: boolean;
}

/**
 * One member of the host's native call. It mirrors the server's `VoiceState`
 * roster, except that `speaking` is the shell's own reading of inbound RTP
 * (`audioLevel`), which the server never sees because audio stays off it.
 */
export interface HostVoiceMember {
  id: string;
  name: string;
  muted: boolean;
  sharing: boolean;
  speaking: boolean;
}

/** Call state the shell pushes while its native call is up. */
export interface HostVoiceStateMessage {
  version: 1;
  type: 'state';
  channelId: string;
  channelName: string | null;
  self: HostVoiceSelf;
  /**
   * Everyone in the call, this member included, so the sidebar can render the
   * roster without a second source. `self` carries the extra `deafened` flag.
   */
  members: HostVoiceMember[];
}

/** Terminal message: the native call has ended. */
export interface HostVoiceLeftMessage {
  version: 1;
  type: 'left';
}

export type HostVoiceMessage = HostVoiceStateMessage | HostVoiceLeftMessage;

/**
 * The `window` event a shell may dispatch instead of calling the bridge
 * callback. Both are accepted so the shell can pick whichever its webview makes
 * easier; the callback is the one described in the contract.
 */
export const HOST_VOICE_EVENT = 'harmony:voice-state';

/** The bridge the shell injects so the client can hand a call to its native voice. */
export interface VoiceHost {
  postMessage(message: string): void;
  /**
   * Where the shell delivers call state. The client assigns this on start; the
   * shell calls it, or dispatches `HOST_VOICE_EVENT` with the same payload.
   */
  onState?: (message: unknown) => void;
}

/** The host bridge, when the shell injected one. Null in a plain browser. */
export function voiceHost(): VoiceHost | null {
  const host = (globalThis as { HarmonyVoiceHost?: VoiceHost }).HarmonyVoiceHost;
  return host && typeof host.postMessage === 'function' ? host : null;
}

/**
 * The most members one host call may report. A real channel holds far fewer, so
 * the cap only ever bites on a buggy or hostile shell.
 */
export const HOST_VOICE_MAX_MEMBERS = 100;
/** The longest an id may be; a longer one cannot name a real channel or member. */
export const HOST_VOICE_MAX_ID = 64;
/** The longest a member display name may be; the rest is dropped. */
export const HOST_VOICE_MAX_NAME = 128;
/** The longest a channel name may be; the rest is dropped. */
export const HOST_VOICE_MAX_CHANNEL_NAME = 128;

/**
 * Reads one host message, or null when it is not a v1 host message.
 *
 * The shell is a separate program on the other side of a bridge, so nothing
 * here is trusted: an unknown type is dropped, a state message without a
 * channel id is useless and dropped, and every field is normalised so a
 * renderer never reads a value that was not there. A JSON string is accepted as
 * well as an object, since a shell that calls in through `evaluateJavascript`
 * may hand over the encoded form.
 *
 * Sizes are bounded here at the one choke point, because this is the only place
 * shell input becomes roster rows: the member list is capped before it is
 * walked, an over-long id (which cannot be real) drops its entry, a display or
 * channel name is truncated to its bound, and a repeated id is collapsed so the
 * sidebar's keyed each renders one row per member. Without these a shell could
 * hand over an unbounded roster and stall or exhaust the renderer.
 */
export function parseHostVoiceMessage(raw: unknown): HostVoiceMessage | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.version !== 1) return null;
  if (message.type === 'left') return { version: 1, type: 'left' };
  if (message.type !== 'state') return null;
  if (
    typeof message.channelId !== 'string' ||
    message.channelId.length === 0 ||
    message.channelId.length > HOST_VOICE_MAX_ID
  ) {
    return null;
  }

  const self = (message.self ?? null) as Record<string, unknown> | null;
  const members: HostVoiceMember[] = [];
  const seen = new Set<string>();
  if (Array.isArray(message.members)) {
    // Slice before the walk, so a roster of any size costs at most the cap.
    for (const entry of message.members.slice(0, HOST_VOICE_MAX_MEMBERS)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const member = entry as Record<string, unknown>;
      if (typeof member.id !== 'string' || member.id.length === 0 || member.id.length > HOST_VOICE_MAX_ID) continue;
      // The sidebar keys its rows by id, so a repeat would be a duplicate key.
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      members.push({
        id: member.id,
        name:
          typeof member.name === 'string' && member.name.length > 0 ? member.name.slice(0, HOST_VOICE_MAX_NAME) : member.id,
        muted: member.muted === true,
        sharing: member.sharing === true,
        speaking: member.speaking === true,
      });
    }
  }

  return {
    version: 1,
    type: 'state',
    channelId: message.channelId,
    channelName:
      typeof message.channelName === 'string' ? message.channelName.slice(0, HOST_VOICE_MAX_CHANNEL_NAME) : null,
    self: {
      muted: self?.muted === true,
      deafened: self?.deafened === true,
      sharing: self?.sharing === true,
    },
    members,
  };
}

/**
 * Starts listening for the call state the shell pushes back while it runs voice
 * natively. The shell's injected bridge carries an `onState` slot the client
 * assigns, and the same payload is accepted as a `HOST_VOICE_EVENT` window
 * event for a shell that would rather dispatch than call in.
 *
 * Returns a function that detaches both, which is what a logout does.
 */
export function subscribeHostVoiceState(handler: (message: HostVoiceMessage) => void): () => void {
  const deliver = (raw: unknown): void => {
    const message = parseHostVoiceMessage(raw);
    if (message) handler(message);
  };
  const host = voiceHost();
  if (host) host.onState = deliver;

  // Node has no window, and the smoke test runs this module there, so the event
  // side is wired only where the environment actually has a listener target.
  const target = globalThis as unknown as {
    addEventListener?: (type: string, listener: (event: Event) => void) => void;
    removeEventListener?: (type: string, listener: (event: Event) => void) => void;
  };
  const onEvent = (event: Event): void => deliver((event as CustomEvent<unknown>).detail);
  target.addEventListener?.(HOST_VOICE_EVENT, onEvent);

  return () => {
    if (host && host.onState === deliver) host.onState = undefined;
    target.removeEventListener?.(HOST_VOICE_EVENT, onEvent);
  };
}

/**
 * Hands a voice channel to the host, which starts its native call. Returns false
 * when there is no host, so the caller falls back to the web client's own join.
 */
export function askHostToJoin(channelId: string, channelName: string): boolean {
  const host = voiceHost();
  if (!host) return false;
  host.postMessage(JSON.stringify({ type: 'join', channelId, channelName }));
  return true;
}

/**
 * Asks the host to end its native call, so leaving from the sidebar's own row
 * goes through the same bridge that started it. Returns false when there is no
 * host, so the caller falls back to the web client's own leave.
 */
export function askHostToLeave(): boolean {
  const host = voiceHost();
  if (!host) return false;
  host.postMessage(JSON.stringify({ type: 'leave' }));
  return true;
}
