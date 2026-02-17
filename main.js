const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  ipcMain,
  nativeTheme,
  Notification,
  session,
  dialog,
  nativeImage,
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');

// Keep references to prevent garbage collection
let mainWindow = null;
let tray = null;
let isQuitting = false;
let windowState = {};
let saveTimeout = null;

const MESSENGER_URL = 'https://www.facebook.com/messages/';
const USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

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
  return { width: 1200, height: 800 };
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
  if (!mainWindow || mainWindow.isDestroyed()) return;
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
      const currentUrl = mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.webContents.getURL()
        : '';
      const onMessenger = currentUrl.includes('/messages');
      if (onMessenger) return url;
    }
  } catch {}

  return null;
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      partition: 'persist:messenger',
    },
  });

  if (state.isMaximized) mainWindow.maximize();
  if (state.isFullScreen) mainWindow.setFullScreen(true);

  // Set user agent
  mainWindow.webContents.setUserAgent(USER_AGENT);

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load Messenger
  mainWindow.loadURL(MESSENGER_URL);

  // --- Permission Handling ---

  const ses = session.fromPartition('persist:messenger');

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    if (isTrustedDomain(url) && ALLOWED_PERMISSIONS.includes(permission)) {
      callback(true);
    } else if (isAllowedDomain(url) && permission === 'notifications') {
      // Allow notifications from broader Facebook domains
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

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const externalUrl = shouldOpenExternally(url);
    if (externalUrl) {
      event.preventDefault();
      shell.openExternal(externalUrl);
    }
  });

  // Handle new windows (target="_blank", window.open, etc.)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = shouldOpenExternally(url);
    if (externalUrl) {
      shell.openExternal(externalUrl);
    } else {
      mainWindow.loadURL(url);
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
    }
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

ipcMain.on('update-badge', (event, count) => {
  if (app.dock) {
    if (count > 0) {
      app.dock.setBadge(count.toString());
      // Bounce dock icon if window is not focused
      if (mainWindow && !mainWindow.isFocused()) {
        app.dock.bounce('informational');
      }
    } else {
      app.dock.setBadge('');
    }
  }
});

ipcMain.on('find-in-page', (event, text) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (text) {
      mainWindow.webContents.findInPage(text);
    } else {
      mainWindow.webContents.stopFindInPage('clearSelection');
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
            if (mainWindow) {
              mainWindow.show();
              mainWindow.webContents.loadURL(
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
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'History',
      submenu: [
        {
          label: 'Back',
          accelerator: 'CmdOrCtrl+[',
          click: () => {
            if (mainWindow && mainWindow.webContents.canGoBack()) {
              mainWindow.webContents.goBack();
            }
          },
        },
        {
          label: 'Forward',
          accelerator: 'CmdOrCtrl+]',
          click: () => {
            if (mainWindow && mainWindow.webContents.canGoForward()) {
              mainWindow.webContents.goForward();
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

app.on('ready', () => {
  buildMenu();
  createWindow();
  createTray();
});

app.on('before-quit', () => {
  isQuitting = true;
  saveWindowState();
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
