class UiState {
  adminOpen = $state(false);
  profileOpen = $state(false);

  openAdmin(): void {
    this.adminOpen = true;
  }

  closeAdmin(): void {
    this.adminOpen = false;
  }

  openProfile(): void {
    this.profileOpen = true;
  }

  closeProfile(): void {
    this.profileOpen = false;
  }
}

export const ui = new UiState();
