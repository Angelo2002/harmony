/*
 * Harmony's service worker.
 *
 * It caches nothing, on purpose. The app is useless without the server, and a
 * cached shell would risk serving a stale bundle after an update, so every
 * request is left to the network. The worker exists because a registered service
 * worker is what lets a browser install the app to the home screen as a real web
 * app rather than a bookmark.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
