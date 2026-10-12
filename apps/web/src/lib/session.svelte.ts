import type { LinkedUser } from '@harmony/shared';

/** Shared, reactive session state for the client. */
class SessionState {
  user = $state<LinkedUser | null>(null);
  permissions = $state('0');

  get isSignedIn(): boolean {
    return this.user !== null;
  }
}

export const session = new SessionState();
