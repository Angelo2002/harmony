<script lang="ts">
  import { Permission, hasPermission, type Message } from '@harmony/shared';
  import { ApiError, api } from '../lib/api';
  import { session } from '../lib/session.svelte';

  /**
   * The Pin / Unpin entry in a message's action menu, shown only to members who
   * manage messages. The server echoes the change back as a message update, so
   * the marker and the pins panel follow without anything being patched here.
   */
  let {
    message,
    ondone,
    onerror,
  }: { message: Message; ondone: () => void; onerror: (text: string) => void } = $props();

  const allowed = $derived(hasPermission(BigInt(session.permissions || '0'), Permission.ManageMessages));

  async function toggle(): Promise<void> {
    ondone();
    try {
      await api(`/channels/${message.channelId}/pins/${message.id}`, {
        method: message.pinnedAt ? 'DELETE' : 'PUT',
      });
    } catch (cause) {
      onerror(cause instanceof ApiError ? cause.message : String(cause));
    }
  }
</script>

{#if allowed}
  <button type="button" title={message.pinnedAt ? 'Unpin' : 'Pin'} onclick={toggle}>
    {message.pinnedAt ? 'Unpin' : 'Pin'}
  </button>
{/if}
