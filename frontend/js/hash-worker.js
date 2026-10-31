'use strict';

/**
 * SHA-256 hashing worker.
 *
 * Keeps large file hashing off the UI thread so uploads never freeze
 * scrolling, animations, or input handling.
 */
self.addEventListener('message', async (event) => {
  const { id, buffer } = event.data || {};
  if (!id || !buffer) return;
  try {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const hash = [...new Uint8Array(digest)]
      .map((item) => item.toString(16).padStart(2, '0'))
      .join('');
    self.postMessage({ id, hash });
  } catch (error) {
    self.postMessage({ id, error: error?.message || 'Hashing failed.' });
  }
});
