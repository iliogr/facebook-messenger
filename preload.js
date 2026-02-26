const { contextBridge, ipcRenderer } = require('electron');

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

// --- Unread Badge Detection (messages only, excludes notification bell) ---
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

  // Check if an element is inside a notification/bell area (not chat messages)
  function isInsideNotificationArea(el) {
    let node = el;
    for (let i = 0; i < 15 && node; i++) {
      if (node.getAttribute) {
        const label = (node.getAttribute('aria-label') || '').toLowerCase();
        const testId = (node.getAttribute('data-testid') || '').toLowerCase();
        if (
          label.includes('notification') ||
          testId.includes('notification')
        ) {
          return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  function getCountFromDOM() {
    // Strategy 1: aria-label with "unread" — only message-related elements
    const ariaEls = document.querySelectorAll('[aria-label*="unread" i]');
    for (const el of ariaEls) {
      if (isInsideNotificationArea(el)) continue;
      const match = el.getAttribute('aria-label').match(/(\d+)\s*unread/i);
      if (match) return parseInt(match[1], 10);
    }

    // Strategy 2: Badge counter elements, excluding notification bell area
    const selectors = [
      'nav span[data-testid]',
      '[role="navigation"] span',
      'span[class*="badge"]',
      'span[class*="jewel"]',
      'span[class*="count"]',
      'div[class*="badge"]',
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (isInsideNotificationArea(el)) continue;
        const text = el.textContent.trim();
        if (/^\d{1,4}$/.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.width < 40 && rect.height < 40) {
            return parseInt(text, 10);
          }
        }
      }
    }

    return 0;
  }

  function detectUnreadCount() {
    // Try title first (cheap) then refine with DOM if needed
    let count = getCountFromTitle();

    // Use DOM scanning to get a message-specific count (excludes bell badges)
    const domCount = getCountFromDOM();
    if (domCount > 0) {
      count = domCount;
    }

    if (count !== lastCount) {
      lastCount = count;
      ipcRenderer.send('update-badge', count);
    }
  }

  // Debounce DOM-triggered detection to avoid thrashing during page load
  let detectTimeout = null;
  function debouncedDetect() {
    if (detectTimeout) return;
    detectTimeout = setTimeout(() => {
      detectTimeout = null;
      detectUnreadCount();
    }, 300);
  }

  // Watch for title element being added/replaced in head
  const headObserver = new MutationObserver(() => {
    observeTitle();
    debouncedDetect();
  });
  headObserver.observe(document.head, { childList: true });

  // Watch for broad DOM changes (catches badge elements appearing/updating)
  const bodyObserver = new MutationObserver(debouncedDetect);
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
  overrideNotifications();
  watchUnreadCount();
}
