import type { PushPayload } from '@harmony/shared';

/**
 * What one delivery attempt came back as. The sender never throws, so the
 * fan-out can treat a failure as data and keep going to the member's other
 * devices.
 */
export type PushSendResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * True when the provider says the endpoint is dead (a `404`/`410`, or a
       * provider's own "unregistered"). Retrying cannot help; the registration
       * is pruned instead.
       */
      gone: boolean;
      /** A short, non-secret reason for the log. */
      error: string;
    };

/**
 * Delivers one payload to one device. Provider-agnostic by design: the endpoint
 * is whatever URL the install registered, and the payload travels as its JSON
 * body. A real provider (UnifiedPush/ntfy, Web Push, FCM) can be added behind
 * this interface without the fan-out learning its name.
 */
export interface PushSender {
  send(endpoint: string, payload: PushPayload): Promise<PushSendResult>;
}

export interface HttpPushSenderOptions {
  /** Abort a delivery that a distributor never answers, in milliseconds. */
  timeoutMs?: number;
  /** Injected by tests; a real run uses the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Long enough for a slow distributor, short enough not to leak a socket. */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * A plain HTTP POST of the payload JSON. The receiver reads the body as UTF-8
 * JSON, which is the whole UnifiedPush/ntfy contract: no signature, no provider
 * SDK, no server-side account.
 */
export function createHttpPushSender(options: HttpPushSenderOptions = {}): PushSender {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async send(endpoint, payload) {
      let target: URL;
      try {
        target = new URL(endpoint);
      } catch {
        return { ok: false, gone: false, error: 'invalid_endpoint' };
      }
      // A registration is a capability URL; anything that is not a web address
      // is refused rather than handed to fetch.
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return { ok: false, gone: false, error: 'unsupported_endpoint' };
      }

      try {
        const response = await fetchImpl(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) return { ok: true };
        // 404 and 410 both mean "this endpoint no longer exists", which a
        // distributor answers once the registration behind it is gone.
        const gone = response.status === 404 || response.status === 410;
        return { ok: false, gone, error: `status_${response.status}` };
      } catch (error) {
        // A timeout or a refused connection is transient; the next mention can
        // try again. Only a definite "gone" prunes the registration.
        const name = error instanceof Error ? error.name : 'request_failed';
        return { ok: false, gone: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : name };
      }
    },
  };
}
