import { MediaQuery } from 'svelte/reactivity';
import type { Channel, User } from '@harmony/shared';
import type { AdminTabId } from './admin';

/**
 * The narrow layout, where the channel and member lists become drawers. The
 * width is the one the mobile block of app.css switches on; the two must agree.
 */
const narrowLayout = new MediaQuery('(max-width: 768px)');

/*
 * Whether the member list is put away on a wide screen, remembered per browser.
 * It is only a matter of how this one viewer likes the window laid out, so it
 * never goes near the server, and storage that refuses (a private window,
 * blocked site data) just means the list starts out shown.
 */
const membersHiddenKey = 'harmony.membersHidden';

function readMembersHidden(): boolean {
  try {
    return localStorage.getItem(membersHiddenKey) === '1';
  } catch {
    return false;
  }
}

class UiState {
  adminOpen = $state(false);
  /** The tab to select when the admin panel next opens. */
  adminTab = $state<AdminTabId>('settings');
  aboutOpen = $state(false);
  profileOpen = $state(false);
  searchOpen = $state(false);
  inboxOpen = $state(false);
  pinsOpen = $state(false);
  savedOpen = $state(false);
  scheduledOpen = $state(false);
  eventsOpen = $state(false);
  /** The channel whose media gallery is open, or null. */
  gallery: Channel | null = $state(null);
  /** The member whose full profile viewer is open, or null. */
  profileViewerUser = $state<User | null>(null);
  /** Off-canvas navigation, used on narrow screens. */
  sidebarOpen = $state(false);
  rosterOpen = $state(false);
  /**
   * The member list put away on a wide screen. A narrow screen ignores it: there
   * the list is the drawer above, which starts closed whatever this says.
   */
  membersHidden = $state(readMembersHidden());

  /** Whether the layout is the narrow one, with drawers for the side lists. */
  get narrow(): boolean {
    return narrowLayout.current;
  }

  /** Whether the member list is on screen, whichever form it takes at this width. */
  get membersShown(): boolean {
    return this.narrow ? this.rosterOpen : !this.membersHidden;
  }

  openAbout(): void {
    this.closeDrawers();
    this.#closePanels();
    this.aboutOpen = true;
  }

  closeAbout(): void {
    this.aboutOpen = false;
  }

  openSearch(): void {
    this.closeDrawers();
    this.#closePanels();
    this.searchOpen = true;
  }

  closeSearch(): void {
    this.searchOpen = false;
  }

  openInbox(): void {
    this.closeDrawers();
    this.#closePanels();
    this.inboxOpen = true;
  }

  closeInbox(): void {
    this.inboxOpen = false;
  }

  openPins(): void {
    this.closeDrawers();
    this.#closePanels();
    this.pinsOpen = true;
  }

  closePins(): void {
    this.pinsOpen = false;
  }

  openSaved(): void {
    this.closeDrawers();
    this.#closePanels();
    this.savedOpen = true;
  }

  closeSaved(): void {
    this.savedOpen = false;
  }

  openScheduled(): void {
    this.closeDrawers();
    this.#closePanels();
    this.scheduledOpen = true;
  }

  closeScheduled(): void {
    this.scheduledOpen = false;
  }

  openEvents(): void {
    this.closeDrawers();
    this.#closePanels();
    this.eventsOpen = true;
  }

  closeEvents(): void {
    this.eventsOpen = false;
  }

  /** Opens one channel's media gallery. The channel need not be the open one. */
  openGallery(channel: Channel): void {
    this.closeDrawers();
    this.#closePanels();
    this.gallery = channel;
  }

  closeGallery(): void {
    this.gallery = null;
  }

  openAdmin(tab: AdminTabId = 'settings'): void {
    this.closeDrawers();
    this.#closePanels();
    this.adminTab = tab;
    this.adminOpen = true;
  }

  closeAdmin(): void {
    this.adminOpen = false;
  }

  openProfile(): void {
    this.closeDrawers();
    this.#closePanels();
    this.profileOpen = true;
  }

  closeProfile(): void {
    this.profileOpen = false;
  }

  /** Opens the big, fixed profile viewer for one member. */
  openProfileViewer(user: User): void {
    this.closeDrawers();
    this.#closePanels();
    this.profileViewerUser = user;
  }

  closeProfileViewer(): void {
    this.profileViewerUser = null;
  }

  /**
   * Only one modal panel is ever open at once, so opening any of them closes
   * the rest, however they were reached. Bumping a panel through the console or
   * another asynchronous path cannot leave two overlays stacked.
   */
  #closePanels(): void {
    this.aboutOpen = false;
    this.adminOpen = false;
    this.profileOpen = false;
    this.searchOpen = false;
    this.inboxOpen = false;
    this.pinsOpen = false;
    this.savedOpen = false;
    this.scheduledOpen = false;
    this.eventsOpen = false;
    this.gallery = null;
    this.profileViewerUser = null;
  }

  /** Only one drawer is ever open, so they never overlap. */
  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
    this.rosterOpen = false;
  }

  toggleRoster(): void {
    this.rosterOpen = !this.rosterOpen;
    this.sidebarOpen = false;
  }

  /**
   * Shows or hides the member list the way the screen has it: the drawer on a
   * narrow one, the remembered choice on a wide one. The members button and
   * Ctrl+U both come here, so they never disagree about which applies.
   */
  toggleMembers(): void {
    if (this.narrow) {
      this.toggleRoster();
      return;
    }
    this.membersHidden = !this.membersHidden;
    try {
      if (this.membersHidden) localStorage.setItem(membersHiddenKey, '1');
      else localStorage.removeItem(membersHiddenKey);
    } catch {
      // Remembered for this visit only.
    }
  }

  closeDrawers(): void {
    this.sidebarOpen = false;
    this.rosterOpen = false;
  }

  /** Closes every drawer and panel, for a step back or forward that changes the channel under them. */
  closeAll(): void {
    this.closeDrawers();
    this.#closePanels();
  }
}

export const ui = new UiState();
