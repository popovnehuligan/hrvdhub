/* Settings of the app: the only file that changes when it goes live. */
window.WISHLIST_CONFIG = {
  // Address of the wishlist server (Cloudflare Worker, worker/). Empty → demo mode:
  // the app shows a sample wishlist and keeps changes only on this device.
  API: 'https://hrvd-wishlist.horovod.workers.dev/',
};
