/**
 * The one image shown large over the app. A shared store, opened from wherever an
 * image is clicked and rendered by the single `Lightbox` component at the app
 * root, so there is one overlay rather than one per image.
 *
 * The point is clients with no second tab to open an image in — the desktop app —
 * and anyone who would rather not leave the page. The links that used to open the
 * picture in a tab keep their `href`, so open-in-new-tab and the no-script case
 * still work; a click just resolves to this instead.
 */
class LightboxState {
  /** The image to show, or null when nothing is open. */
  url = $state<string | null>(null);
  alt = $state('');

  open(url: string, alt = ''): void {
    this.url = url;
    this.alt = alt;
  }

  close(): void {
    this.url = null;
    this.alt = '';
  }
}

export const lightbox = new LightboxState();
