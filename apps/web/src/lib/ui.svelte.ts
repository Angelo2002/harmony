class UiState {
  adminOpen = $state(false);
  aboutOpen = $state(false);
  profileOpen = $state(false);
  searchOpen = $state(false);
  inboxOpen = $state(false);
  pinsOpen = $state(false);
  savedOpen = $state(false);
  /** Off-canvas navigation, used on narrow screens. */
  sidebarOpen = $state(false);
  rosterOpen = $state(false);

  openAbout(): void {
    this.closeDrawers();
    this.aboutOpen = true;
  }

  closeAbout(): void {
    this.aboutOpen = false;
  }

  openSearch(): void {
    this.closeDrawers();
    this.searchOpen = true;
  }

  closeSearch(): void {
    this.searchOpen = false;
  }

  openInbox(): void {
    this.closeDrawers();
    this.inboxOpen = true;
  }

  closeInbox(): void {
    this.inboxOpen = false;
  }

  openPins(): void {
    this.closeDrawers();
    this.pinsOpen = true;
  }

  closePins(): void {
    this.pinsOpen = false;
  }

  openSaved(): void {
    this.closeDrawers();
    this.savedOpen = true;
  }

  closeSaved(): void {
    this.savedOpen = false;
  }

  openAdmin(): void {
    this.closeDrawers();
    this.adminOpen = true;
  }

  closeAdmin(): void {
    this.adminOpen = false;
  }

  openProfile(): void {
    this.closeDrawers();
    this.profileOpen = true;
  }

  closeProfile(): void {
    this.profileOpen = false;
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

  closeDrawers(): void {
    this.sidebarOpen = false;
    this.rosterOpen = false;
  }
}

export const ui = new UiState();
