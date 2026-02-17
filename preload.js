const { contextBridge, ipcRenderer } = require('electron');

// --- Inject CSS for hidden title bar padding ---
function injectTitleBarCSS() {
  const style = document.createElement('style');
  style.textContent = `
    /* Draggable title bar in the 40px gap above content */
    html::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 40px;
      -webkit-app-region: drag;
      z-index: 99999;
    }
    /* Pin the body below the title bar area, filling the rest of the viewport */
    body {
      position: fixed !important;
      top: 40px !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      overflow: hidden !important;
    }
  `;
  document.head.appendChild(style);
}

// --- Notification Override ---
function overrideNotifications() {
  class CustomNotification {
    constructor(title, options = {}) {
      this._listeners = { click: [], close: [], error: [], show: [] };

      // Send to main process for native notification
      ipcRenderer.send('show-notification', {
        title,
        body: options.body || '',
        icon: options.icon || '',
      });

      this.title = title;
      this.body = options.body || '';
      this.icon = options.icon || '';
      this.onclick = null;
      this.onclose = null;
      this.onerror = null;
      this.onshow = null;
    }

    close() {}

    addEventListener(type, listener) {
      if (this._listeners[type]) {
        this._listeners[type].push(listener);
      }
    }

    removeEventListener(type, listener) {
      if (this._listeners[type]) {
        this._listeners[type] = this._listeners[type].filter(
          (l) => l !== listener
        );
      }
    }

    dispatchEvent(event) {
      const type = event.type;
      if (this._listeners[type]) {
        this._listeners[type].forEach((l) => l(event));
      }
      if (this['on' + type]) {
        this['on' + type](event);
      }
      return true;
    }

    static get permission() {
      return 'granted';
    }

    static requestPermission(callback) {
      const result = Promise.resolve('granted');
      if (callback) callback('granted');
      return result;
    }
  }

  window.Notification = CustomNotification;
}

// --- Unread Badge Detection ---
function watchUnreadCount() {
  let lastCount = 0;
  let lastTitleEl = null;

  const titleObserver = new MutationObserver(detectUnreadCount);

  function observeTitle() {
    const titleEl = document.querySelector('title');
    if (titleEl && titleEl !== lastTitleEl) {
      lastTitleEl = titleEl;
      titleObserver.observe(titleEl, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  }

  function getCountFromTitle() {
    const title = document.title || '';
    // Match patterns like "Messenger (3)", "(3) Messenger", "Чаты (3)", etc.
    const match = title.match(/\((\d+)\)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  function getCountFromDOM() {
    // Strategy 1: Look for aria-label with "unread" on badge-like elements
    const ariaEls = document.querySelectorAll('[aria-label*="unread" i]');
    for (const el of ariaEls) {
      const match = el.getAttribute('aria-label').match(/(\d+)\s*unread/i);
      if (match) return parseInt(match[1], 10);
    }

    // Strategy 2: Look for the Messenger notification jewel / badge counter
    // Messenger uses a small red circle with a number inside near the chat list
    const selectors = [
      // Badge-like spans inside navigation or header
      'nav span[data-testid]',
      '[role="navigation"] span',
      // Common badge patterns - small elements with just a number
      'span[class*="badge"]',
      'span[class*="jewel"]',
      'span[class*="count"]',
      'div[class*="badge"]',
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const text = el.textContent.trim();
        // Must be a standalone number (1-4 digits) in a small element
        if (/^\d{1,4}$/.test(text)) {
          const rect = el.getBoundingClientRect();
          // Badge elements are typically small (under 40px)
          if (rect.width > 0 && rect.width < 40 && rect.height < 40) {
            return parseInt(text, 10);
          }
        }
      }
    }

    // Strategy 3: Check the favicon link for a badge indicator
    const favicons = document.querySelectorAll('link[rel*="icon"]');
    for (const fav of favicons) {
      const href = fav.getAttribute('href') || '';
      // Messenger sometimes encodes badge state in a data URI favicon
      if (href.startsWith('data:') && href.length > 200) {
        // A data URI favicon that's significantly larger than the default
        // likely has a badge overlay drawn on it — treat as "has unread"
        // We can't parse the exact count, so return 1 as indicator
        // But only if we don't already have a count from other methods
      }
    }

    return 0;
  }

  function detectUnreadCount() {
    // Try title first (most reliable when available)
    let count = getCountFromTitle();

    // Fall back to DOM scanning
    if (count === 0) {
      count = getCountFromDOM();
    }

    if (count !== lastCount) {
      lastCount = count;
      ipcRenderer.send('update-badge', count);
    }
  }

  // Watch for title element being added/replaced in head
  const headObserver = new MutationObserver(() => {
    observeTitle();
    detectUnreadCount();
  });
  headObserver.observe(document.head, { childList: true });

  // Watch for broad DOM changes (catches badge elements appearing/updating)
  const bodyObserver = new MutationObserver(detectUnreadCount);
  const startBodyObserver = () => {
    if (document.body) {
      bodyObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  };

  // Initial observation
  observeTitle();
  startBodyObserver();

  // Poll as fallback
  setInterval(detectUnreadCount, 2000);

  // Initial check
  detectUnreadCount();
}

// --- Expose limited API to renderer ---
contextBridge.exposeInMainWorld('messengerDesktop', {
  platform: process.platform,
});

// --- Initialize on DOM ready ---
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
  if (process.platform === 'darwin') {
    injectTitleBarCSS();
  }
  overrideNotifications();
  watchUnreadCount();
}
