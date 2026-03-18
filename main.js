const {
  app,
  BrowserWindow,
  BrowserView,
  Menu,
  Tray,
  shell,
  ipcMain,
  nativeTheme,
  Notification,
  session,
  nativeImage,
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

// Debug logging
const DEBUG_LOG = path.join(require('os').homedir(), 'Desktop', 'messenger-debug.log');
function debugLog(msg) { fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`); }

ipcMain.on('debug-log', (event, data) => {
  debugLog(JSON.stringify(data));
});

// Keep references to prevent garbage collection
let mainWindow = null;
let mainView = null;
let tray = null;
let isQuitting = false;
let windowState = {};
let saveTimeout = null;

const MESSENGER_URL = 'https://www.facebook.com/messages/';
const USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const TITLE_BAR_HEIGHT = process.platform === 'darwin' ? 40 : 0;

// --- Windows Badge Icon (red dot for taskbar overlay) ---

let badgeIcon = null;

function createBadgeIcon() {
  const s = 16;
  const rowBytes = 1 + s * 4;
  const raw = Buffer.alloc(s * rowBytes);
  for (let y = 0; y < s; y++) {
    raw[y * rowBytes] = 0; // PNG filter: None
    for (let x = 0; x < s; x++) {
      const i = y * rowBytes + 1 + x * 4;
      const dx = x - 7.5, dy = y - 7.5;
      if (dx * dx + dy * dy <= 56.25) {
        raw[i] = 228; raw[i + 1] = 30; raw[i + 2] = 63; raw[i + 3] = 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return nativeImage.createFromBuffer(png);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([t, data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(payload));
  return Buffer.concat([len, payload, c]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crc32Table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crc32Table[i] = c;
}

// Domains allowed for navigation
const ALLOWED_DOMAINS = [
  'messenger.com',
  'www.messenger.com',
  'facebook.com',
  'www.facebook.com',
  'fb.com',
  'fbcdn.net',
  'fbsbx.com',
  'facebook.net',
  'accountkit.com',
  'fb.gg',
];

// Domains trusted for elevated permissions (camera, mic, notifications)
const TRUSTED_DOMAINS = [
  'messenger.com',
  'www.messenger.com',
  'facebook.com',
  'www.facebook.com',
];

const ALLOWED_PERMISSIONS = [
  'notifications',
  'media',
  'mediaKeySystem',
  'clipboard-read',
  'fullscreen',
  'display-capture',
];

// --- Window State Persistence ---

const stateFilePath = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(stateFilePath)) {
      const data = fs.readFileSync(stateFilePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    // Ignore corrupted state
  }
  return { width: 1200, height: 920 };
}

function validateWindowPosition(state) {
  if (state.x === undefined || state.y === undefined) return state;

  const displays = screen.getAllDisplays();
  const isVisible = displays.some((display) => {
    const { x, y, width, height } = display.bounds;
    return (
      state.x >= x - 100 &&
      state.x < x + width &&
      state.y >= y - 100 &&
      state.y < y + height
    );
  });

  if (!isVisible) {
    delete state.x;
    delete state.y;
  }
  return state;
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed?.()) return;
  const bounds = mainWindow.getBounds();
  const isMaximized = mainWindow.isMaximized();
  const isFullScreen = mainWindow.isFullScreen();
  windowState = { ...bounds, isMaximized, isFullScreen };
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(windowState));
  } catch (e) {
    // Ignore write errors
  }
}

function debouncedSaveWindowState() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveWindowState, 500);
}

// --- Domain Checking ---

function isDomainMatch(hostname, domainList) {
  return domainList.some(
    (d) => hostname === d || hostname.endsWith('.' + d)
  );
}

function isAllowedDomain(url) {
  try {
    const parsed = new URL(url);
    return isDomainMatch(parsed.hostname, ALLOWED_DOMAINS);
  } catch {
    return false;
  }
}

function isTrustedDomain(url) {
  try {
    const parsed = new URL(url);
    return isDomainMatch(parsed.hostname, TRUSTED_DOMAINS);
  } catch {
    return false;
  }
}

// Facebook wraps shared links through l.facebook.com/l.php?u=<actual_url>
function isFacebookRedirect(url) {
  try {
    const parsed = new URL(url);
    if (
      (parsed.hostname === 'l.facebook.com' ||
        parsed.hostname === 'lm.facebook.com') &&
      parsed.pathname === '/l.php'
    ) {
      return parsed.searchParams.get('u');
    }
  } catch {}
  return null;
}

// Check if a URL should open externally (not part of Messenger UI)
function shouldOpenExternally(url) {
  const redirectTarget = isFacebookRedirect(url);
  if (redirectTarget) return redirectTarget;

  if (!isAllowedDomain(url)) return url;

  // Only redirect facebook.com pages to the browser if we're already
  // logged in and on /messages. During auth flows (login, 2FA, verification)
  // everything must stay in-app so the session completes properly.
  try {
    const parsed = new URL(url);
    if (
      (parsed.hostname === 'www.facebook.com' ||
        parsed.hostname === 'facebook.com') &&
      !parsed.pathname.startsWith('/messages')
    ) {
      const currentUrl = mainView
        ? mainView.webContents.getURL()
        : '';
      const onMessenger = currentUrl.includes('/messages');
      if (onMessenger) return url;
    }
  } catch {}

  return null;
}

// --- Update BrowserView bounds to fill window below title bar ---

function updateViewBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainView) return;
  const { width, height } = mainWindow.getContentBounds();
  mainView.setBounds({
    x: 0,
    y: TITLE_BAR_HEIGHT,
    width,
    height: Math.max(0, height - TITLE_BAR_HEIGHT),
  });
}

// --- Create Main Window ---

function createWindow() {
  const state = validateWindowPosition(loadWindowState());
  const darkMode = nativeTheme.shouldUseDarkColors;

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 400,
    minHeight: 300,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: darkMode ? '#000000' : '#FFFFFF',
    show: false,
  });

  debugLog('[main] creating BrowserView');
  mainView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      partition: 'persist:messenger',
    },
  });

  mainWindow.setBrowserView(mainView);
  updateViewBounds();
  mainView.setAutoResize({ width: true, height: true });

  if (state.isMaximized) mainWindow.maximize();
  if (state.isFullScreen) mainWindow.setFullScreen(true);

  mainWindow.on('resize', updateViewBounds);

  // Set user agent
  mainView.webContents.setUserAgent(USER_AGENT);

  // Load Messenger
  mainView.webContents.loadURL(MESSENGER_URL);

  // Show window once the BrowserView content is ready
  function showOnce() {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }
  mainView.webContents.once('dom-ready', showOnce);
  setTimeout(showOnce, 5000); // fallback if dom-ready doesn't fire

  // --- Unread detection via JS injection (bypasses contextIsolation) ---
  let unreadPollInterval = null;

  function startUnreadPoll() {
    if (unreadPollInterval) clearInterval(unreadPollInterval);
    unreadPollInterval = setInterval(async () => {
      if (!mainView || mainView.webContents.isDestroyed()) {
        clearInterval(unreadPollInterval);
        unreadPollInterval = null;
        return;
      }
      try {
        const count = await mainView.webContents.executeJavaScript(`
          (function() {
            var title = document.title || '';

            // Strategy 1: Title with count — e.g. "(3) Messenger | Facebook"
            var m = title.match(/\\((\\d+)\\)/);
            if (m) return parseInt(m[1], 10);

            // If the title is notification text (e.g. "Lampros messaged f1 predictions")
            // rather than the base "Messenger | Facebook", we can't determine unread count.
            // Return -1 (unknown) so we don't falsely clear the badge.
            var isBaseTitle = /messenger/i.test(title);
            if (!isBaseTitle) return -1;

            // Title is base "Messenger | Facebook" with no count — check DOM for unreads

            // Strategy 2: aria-label with unread count
            var els = document.querySelectorAll('[aria-label]');
            for (var i = 0; i < els.length; i++) {
              var label = els[i].getAttribute('aria-label');
              if (!label) continue;
              var um = label.match(/(\\d+)\\s*unread/i);
              if (um) return parseInt(um[1], 10);
            }

            // Strategy 3: Check for blue dots (unread indicators)
            var chatList = document.querySelector('[role="navigation"]') || document.body;
            var allEls = chatList.querySelectorAll('div, span');
            var dotCount = 0;
            for (var d = 0; d < allEls.length; d++) {
              var rect = allEls[d].getBoundingClientRect();
              if (rect.width >= 6 && rect.width <= 16 && rect.height >= 6 && rect.height <= 16 && Math.abs(rect.width - rect.height) < 2) {
                var style = window.getComputedStyle(allEls[d]);
                var br = parseFloat(style.borderRadius);
                if (br >= rect.width / 2 - 1 || style.borderRadius === '50%') {
                  var bg = style.backgroundColor;
                  if (bg && (bg.includes('0, 132, 255') || bg.includes('0,132,255') || bg.includes('19, 111, 236') || bg.includes('0, 100, 224') || bg.includes('0, 153, 255') || bg.includes('0,153,255'))) {
                    dotCount++;
                  }
                }
              }
            }
            return dotCount;
          })();
        `);
        if (typeof count === 'number' && count >= 0) {
          handleBadgeCount(count);
        }
      } catch (e) {
        // Page may be navigating or destroyed
      }
    }, 3000);
  }

  mainView.webContents.on('dom-ready', startUnreadPoll);

  // --- Favicon-based unread detection ---
  // Messenger changes the favicon when there are unread messages
  // The default favicon is a static .ico; unread favicon is typically a data: URL or different .ico
  let baselineFavicon = null;
  mainView.webContents.on('page-favicon-updated', (event, favicons) => {
    const favicon = favicons[0] || '';
    debugLog(`[favicon] ${favicon.substring(0, 120)}`);
    if (!baselineFavicon) {
      baselineFavicon = favicon;
    }
  });

  // --- Title-based unread detection from main process ---
  mainView.webContents.on('page-title-updated', (event, title) => {
    debugLog(`[title] ${title}`);
    const match = title.match(/\((\d+)\)/);
    if (match) {
      const count = parseInt(match[1], 10);
      handleBadgeCount(count);
    }
  });

  // --- Permission Handling ---

  const ses = session.fromPartition('persist:messenger');

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    if (isTrustedDomain(url) && ALLOWED_PERMISSIONS.includes(permission)) {
      callback(true);
    } else if (isAllowedDomain(url) && permission === 'notifications') {
      callback(true);
    } else {
      callback(false);
    }
  });

  ses.setPermissionCheckHandler((webContents, permission) => {
    if (!webContents) return true;
    const url = webContents.getURL();
    if (isTrustedDomain(url) && ALLOWED_PERMISSIONS.includes(permission)) {
      return true;
    }
    if (isAllowedDomain(url) && permission === 'notifications') {
      return true;
    }
    return false;
  });

  // --- Navigation Control ---

  mainView.webContents.on('will-navigate', (event, url) => {
    const externalUrl = shouldOpenExternally(url);
    if (externalUrl) {
      event.preventDefault();
      shell.openExternal(externalUrl);
    }
  });

  // Handle new windows (target="_blank", window.open, etc.)
  mainView.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = shouldOpenExternally(url);
    if (externalUrl) {
      shell.openExternal(externalUrl);
    } else {
      mainView.webContents.loadURL(url);
    }
    return { action: 'deny' };
  });

  // --- Download Handling ---

  ses.on('will-download', (event, item) => {
    // Sanitize filename to prevent path traversal
    const fileName = path.basename(item.getFilename());
    const downloadsPath = app.getPath('downloads');
    const savePath = path.join(downloadsPath, fileName);

    item.setSavePath(savePath);

    item.on('updated', (event, state) => {
      if (state === 'progressing' && !item.isPaused()) {
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();
        if (total > 0 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setProgressBar(received / total);
        }
      }
    });

    item.once('done', (event, state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setProgressBar(-1); // Remove progress bar
      }
      if (state === 'completed') {
        const notif = new Notification({
          title: 'Download Complete',
          body: fileName,
        });
        notif.on('click', () => {
          shell.showItemInFolder(savePath);
        });
        notif.show();
      }
    });
  });

  // --- Window Events ---

  mainWindow.on('close', (event) => {
    saveWindowState();
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    } else {
      // Clean up interval before window is destroyed
      if (unreadPollInterval) {
        clearInterval(unreadPollInterval);
        unreadPollInterval = null;
      }
      if (saveTimeout) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
      }
    }
  });

  mainWindow.on('closed', () => {
    mainView = null;
    mainWindow = null;
  });

  mainWindow.on('resize', debouncedSaveWindowState);
  mainWindow.on('move', debouncedSaveWindowState);
}

// --- IPC Handlers ---

ipcMain.on('notification-click', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

ipcMain.on('show-notification', (event, { title, body, icon }) => {
  const notif = new Notification({
    title: title || 'Messenger',
    body: body || '',
    silent: false,
  });

  notif.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  notif.show();
});

let lastBadgeCount = 0;
let badgeZeroStreak = 0;
const BADGE_ZERO_THRESHOLD = 2;

function handleBadgeCount(count) {
  // Any non-zero reading resets the zero streak, even if count matches current badge.
  // This prevents the streak from accumulating across alternating title changes.
  if (count > 0) {
    badgeZeroStreak = 0;
    if (count === lastBadgeCount) return;
  }

  if (count === 0) {
    if (lastBadgeCount === 0) return;
    badgeZeroStreak++;
    if (badgeZeroStreak < BADGE_ZERO_THRESHOLD) return;
  }

  const prevCount = lastBadgeCount;
  lastBadgeCount = count;

  debugLog(`[badge] setting badge count=${count} (prev=${prevCount})`);

  // macOS: dock badge
  if (app.dock) {
    app.dock.setBadge(count > 0 ? count.toString() : '');
  }

  // Windows: taskbar overlay icon (red dot badge)
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    if (count > 0) {
      mainWindow.setOverlayIcon(badgeIcon, `${count} unread messages`);
      if (!mainWindow.isFocused() && count > prevCount) {
        mainWindow.flashFrame(true);
      }
    } else {
      mainWindow.setOverlayIcon(null, '');
      mainWindow.flashFrame(false);
    }
  }
}

ipcMain.on('update-badge', (event, count) => {
  handleBadgeCount(count);
});

ipcMain.on('find-in-page', (event, text) => {
  if (mainView) {
    if (text) {
      mainView.webContents.findInPage(text);
    } else {
      mainView.webContents.stopFindInPage('clearSelection');
    }
  }
});

// --- Dark Mode ---

nativeTheme.on('updated', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(
      nativeTheme.shouldUseDarkColors ? '#000000' : '#FFFFFF'
    );
  }
});

// --- macOS Menu ---

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow && mainView) {
              mainWindow.show();
              mainView.webContents.loadURL(
                'https://www.facebook.com/messages/preferences'
              );
            }
          },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => { if (mainView) mainView.webContents.reload(); },
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => { if (mainView) mainView.webContents.reloadIgnoringCache(); },
        },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: () => { if (mainView) mainView.webContents.setZoomLevel(0); },
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            if (mainView) {
              mainView.webContents.setZoomLevel(
                mainView.webContents.getZoomLevel() + 0.5
              );
            }
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            if (mainView) {
              mainView.webContents.setZoomLevel(
                mainView.webContents.getZoomLevel() - 0.5
              );
            }
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Toggle Developer Tools',
          accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => { if (mainView) mainView.webContents.toggleDevTools(); },
        },
      ],
    },
    {
      label: 'History',
      submenu: [
        {
          label: 'Back',
          accelerator: 'CmdOrCtrl+[',
          click: () => {
            if (mainView && mainView.webContents.canGoBack()) {
              mainView.webContents.goBack();
            }
          },
        },
        {
          label: 'Forward',
          accelerator: 'CmdOrCtrl+]',
          click: () => {
            if (mainView && mainView.webContents.canGoForward()) {
              mainView.webContents.goForward();
            }
          },
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        {
          label: 'Close',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            if (mainWindow) mainWindow.hide();
          },
        },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Messenger Help',
          click: () => {
            shell.openExternal('https://www.facebook.com/help/messenger-app');
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// --- System Tray ---

function createTray() {
  const trayIconPath = path.join(__dirname, 'assets', 'trayIconTemplate.png');
  // Only create tray if icon exists
  if (!fs.existsSync(trayIconPath)) return;

  const icon = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(icon);
  tray.setToolTip('Messenger');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Messenger',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// --- App Lifecycle ---

// Single instance lock: if a second instance is launched, focus the existing window
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('ready', () => {
    if (process.platform === 'win32') {
      try {
        badgeIcon = createBadgeIcon();
      } catch (e) {
        // Badge overlay won't work but app still launches
      }
    }
    buildMenu();
    createWindow();
    createTray();
  });
  app.on('before-quit', (event) => {
    saveWindowState();
    if (!isQuitting) {
      isQuitting = true;
      event.preventDefault();
      try {
        session.fromPartition('persist:messenger').flushStorageData().then(() => {
          app.quit();
        }).catch(() => {
          app.quit();
        });
      } catch (e) {
        app.quit();
      }
      return;
    }
  });

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
