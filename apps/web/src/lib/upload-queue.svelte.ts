/**
 * Files dropped onto the chat, waiting for the composer to upload them.
 *
 * A tiny hand-off, so the drop target can be the whole chat pane while the
 * composer keeps owning the upload itself.
 */
class UploadQueue {
  #queued = $state<File[]>([]);

  get count(): number {
    return this.#queued.length;
  }

  drop(files: File[]): void {
    if (files.length > 0) this.#queued = [...this.#queued, ...files];
  }

  /** Takes everything queued, leaving the queue empty. */
  take(): File[] {
    const files = this.#queued;
    this.#queued = [];
    return files;
  }
}

export const uploads = new UploadQueue();
