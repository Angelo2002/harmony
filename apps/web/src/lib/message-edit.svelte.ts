import type { Message } from '@harmony/shared';

/**
 * The one message being edited, and its draft. The message list draws the edit
 * box, but the composer starts edits too (the Up arrow in an empty message box
 * edits your last message, as on Discord), so the state lives here rather than
 * in either component. Only one message is ever edited at a time: starting
 * another replaces it, the way clicking Edit on a second message always has.
 */
class MessageEditState {
  /** The message whose edit box is open, or null. */
  id = $state<string | null>(null);
  /** The text in the edit box. */
  draft = $state('');

  start(message: Message): void {
    this.id = message.id;
    this.draft = message.content;
  }

  stop(): void {
    this.id = null;
    this.draft = '';
  }
}

export const messageEdit = new MessageEditState();
