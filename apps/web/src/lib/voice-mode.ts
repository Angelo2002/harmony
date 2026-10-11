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

/** The bridge the shell injects so the client can hand a call to its native voice. */
export interface VoiceHost {
  postMessage(message: string): void;
}

/** The host bridge, when the shell injected one. Null in a plain browser. */
export function voiceHost(): VoiceHost | null {
  const host = (globalThis as { HarmonyVoiceHost?: VoiceHost }).HarmonyVoiceHost;
  return host && typeof host.postMessage === 'function' ? host : null;
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
