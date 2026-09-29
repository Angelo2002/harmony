class UiState {
  adminOpen = $state(false);

  openAdmin(): void {
    this.adminOpen = true;
  }

  closeAdmin(): void {
    this.adminOpen = false;
  }
}

export const ui = new UiState();
