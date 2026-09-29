import type { User } from '@harmony/shared';

/** A rectangle in viewport coordinates, kept plain so it stays reactive. */
interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How long the card lingers after the pointer leaves its trigger. */
const HIDE_DELAY_MS = 180;

/**
 * State for the single profile card a client can have open. Hovering a name
 * opens it, and clicking a member pins it so it survives moving the pointer onto
 * the card itself.
 */
class ProfileCardState {
  user = $state<User | null>(null);
  rect = $state<AnchorRect | null>(null);
  pinned = $state(false);
  #hideTimer: ReturnType<typeof setTimeout> | null = null;

  /** Opens the card next to `element`. */
  show(user: User, element: HTMLElement, pinned = false): void {
    this.#cancel();
    const rect = element.getBoundingClientRect();
    this.user = user;
    this.rect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    this.pinned = pinned;
  }

  /** Closes shortly, unless the card is pinned. */
  scheduleHide(): void {
    if (this.pinned) return;
    this.#cancel();
    this.#hideTimer = setTimeout(() => this.hide(), HIDE_DELAY_MS);
  }

  /** Called when the pointer reaches the card, so it does not vanish en route. */
  cancelHide(): void {
    this.#cancel();
  }

  hide(): void {
    this.#cancel();
    this.user = null;
    this.rect = null;
    this.pinned = false;
  }

  #cancel(): void {
    if (this.#hideTimer === null) return;
    clearTimeout(this.#hideTimer);
    this.#hideTimer = null;
  }
}

export const profileCard = new ProfileCardState();
