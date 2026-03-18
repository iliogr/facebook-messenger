const { contextBridge, ipcRenderer } = require('electron');

// --- Notification Override ---
function overrideNotifications() {
  // With contextIsolation, we can't directly override window.Notification in the
  // main world from the preload. Instead, inject a script into the main world that
  // overrides Notification and communicates back via window.postMessage.
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === '__messenger_notification') {
      ipcRenderer.send('show-notification', {
        title: event.data.title,
        body: event.data.body,
        icon: event.data.icon,
      });
    }
  });

  const script = document.createElement('script');
  script.textContent = `
    (function() {
      class CustomNotification {
        constructor(title, options) {
          options = options || {};
          this._listeners = { click: [], close: [], error: [], show: [] };
          this.title = title;
          this.body = options.body || '';
          this.icon = options.icon || '';
          this.onclick = null;
          this.onclose = null;
          this.onerror = null;
          this.onshow = null;
          window.postMessage({
            type: '__messenger_notification',
            title: title,
            body: options.body || '',
            icon: options.icon || ''
          }, '*');
        }
        close() {}
        addEventListener(type, listener) {
          if (this._listeners[type]) this._listeners[type].push(listener);
        }
        removeEventListener(type, listener) {
          if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter(function(l) { return l !== listener; });
        }
        dispatchEvent(event) {
          var type = event.type;
          if (this._listeners[type]) this._listeners[type].forEach(function(l) { l(event); });
          if (this['on' + type]) this['on' + type](event);
          return true;
        }
        static get permission() { return 'granted'; }
        static requestPermission(callback) {
          var result = Promise.resolve('granted');
          if (callback) callback('granted');
          return result;
        }
      }
      window.Notification = CustomNotification;
    })();
  `;
  function injectScript() {
    if (document.documentElement) {
      document.documentElement.prepend(script);
      script.remove();
    } else {
      // documentElement not yet available, wait for it
      const mo = new MutationObserver(() => {
        if (document.documentElement) {
          mo.disconnect();
          document.documentElement.prepend(script);
          script.remove();
        }
      });
      mo.observe(document, { childList: true });
    }
  }
  injectScript();
}

// --- Unread Badge Detection (messages only, excludes notification bell) ---
function watchUnreadCount() {
  let lastCount = 0;
  let lastTitleEl = null;
  let zeroStreak = 0;
  const ZERO_THRESHOLD = 3;

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
    const match = title.match(/\((\d+)\)/);
    return match ? parseInt(match[1], 10) : 0;
  }

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
    const ariaEls = document.querySelectorAll('[aria-label*="unread" i]');
    for (const el of ariaEls) {
      if (isInsideNotificationArea(el)) continue;
      const match = el.getAttribute('aria-label').match(/(\d+)\s*unread/i);
      if (match) return parseInt(match[1], 10);
    }

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
    const titleCount = getCountFromTitle();
    const domCount = getCountFromDOM();
    let count = domCount > 0 ? domCount : titleCount;

    if (count === 0 && lastCount > 0) {
      zeroStreak++;
      if (zeroStreak < ZERO_THRESHOLD) return;
    } else {
      zeroStreak = 0;
    }

    if (count !== lastCount) {
      lastCount = count;
      ipcRenderer.send('update-badge', count);
    }
  }

  let detectTimeout = null;
  function debouncedDetect() {
    if (detectTimeout) return;
    detectTimeout = setTimeout(() => {
      detectTimeout = null;
      detectUnreadCount();
    }, 300);
  }

  const headObserver = new MutationObserver(() => {
    observeTitle();
    debouncedDetect();
  });
  if (document.head) {
    headObserver.observe(document.head, { childList: true });
  }

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

  observeTitle();
  startBodyObserver();

  setInterval(detectUnreadCount, 2000);

  detectUnreadCount();
}

// --- Expose limited API to renderer ---
contextBridge.exposeInMainWorld('messengerDesktop', {
  platform: process.platform,
});

// --- Initialize ---
ipcRenderer.send('debug-log', { msg: 'preload init', readyState: document.readyState });

// Notification override must run ASAP, but wrapped in try-catch so it never kills badge detection
try {
  overrideNotifications();
  ipcRenderer.send('debug-log', { msg: 'overrideNotifications OK' });
} catch (e) {
  ipcRenderer.send('debug-log', { msg: 'overrideNotifications FAILED', error: e.message });
}

// Badge detection needs DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchUnreadCount);
} else {
  watchUnreadCount();
}
