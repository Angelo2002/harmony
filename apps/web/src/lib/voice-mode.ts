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
