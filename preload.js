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

// --- Unread Badge Detection ---
// With contextIsolation, preload runs in an isolated world. The DOM is shared,
// but computed styles and some dynamic attributes may differ. We rely on the
// main process executeJavaScript poll (main world) as the primary badge source.
// The preload supplements with title observation which works in the isolated world.
function watchUnreadCount() {
  let lastCount = 0;
  let lastTitleEl = null;
  let zeroStreak = 0;
  const ZERO_THRESHOLD = 3;

  const titleObserver = new MutationObserver(detectFromTitle);

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

  function detectFromTitle() {
    const title = document.title || '';
    const match = title.match(/\((\d+)\)/);
    const count = match ? parseInt(match[1], 10) : -1;

    // Only send title-based updates when we actually find a count
    // The main process poll handles DOM-based detection more reliably
    if (count > 0 && count !== lastCount) {
      zeroStreak = 0;
      lastCount = count;
      ipcRenderer.send('update-badge', count);
    } else if (count === 0 || (count === -1 && lastCount > 0)) {
      // Title lost the count — might mean zero unreads
      zeroStreak++;
      if (zeroStreak >= ZERO_THRESHOLD && lastCount > 0) {
        lastCount = 0;
        ipcRenderer.send('update-badge', 0);
      }
    }
  }

  // Watch for title element being added/replaced
  const headObserver = new MutationObserver(() => {
    observeTitle();
    detectFromTitle();
  });
  if (document.head) {
    headObserver.observe(document.head, { childList: true });
  }

  observeTitle();

  // Poll title as fallback
  setInterval(detectFromTitle, 2000);

  detectFromTitle();
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
