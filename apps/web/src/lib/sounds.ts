/**
 * The two in-app notification sounds, served from the web client's own public
 * directory.
 *
 * Nothing here touches device notifications: there is no push, no service
 * worker involvement and no permission prompt. A sound only ever plays while a
 * Harmony page is open, and whether it plays at all is the member's choice.
 */
const SOURCES = {
  /** A message aimed at you: a reply, or your name mentioned. */
  major: '/sounds/major_notification.mp3',
  /** Any other message worth a quieter nudge. */
  minor: '/sounds/minor_notification.mp3',
} as const;

export type NotificationSound = keyof typeof SOURCES;

/** One element per sound, created on first use and then reused. */
const players = new Map<NotificationSound, HTMLAudioElement>();

function createPlayer(sound: NotificationSound): HTMLAudioElement {
  const player = new Audio(SOURCES[sound]);
  players.set(sound, player);
  return player;
}

/**
 * Plays one of the notification sounds. The element is kept between plays so a
 * later message does not have to wait for another fetch, and the sound restarts
 * rather than queues: a burst of messages makes one sound, not ten.
 */
export function playNotification(sound: NotificationSound): void {
  const player = players.get(sound) ?? createPlayer(sound);
  // Before the file has loaded this only moves the playback start, which is
  // exactly what is wanted, and never throws.
  player.currentTime = 0;
  // A browser that has not seen a gesture from the user yet refuses to play.
  // There is nothing to do about that and nothing worth telling anyone.
  void player.play().catch(() => {});
}
