# Messenger Desktop

A native desktop app for Facebook Messenger, built with Electron. Wraps `facebook.com/messages` with native OS integrations for a first-class desktop experience.

## Features

- **Native notifications** — Intercepted from the web page and delivered through the OS notification center
- **Dock badge** — Unread message count displayed on the dock/taskbar icon
- **Persistent login** — Session cookies persist across restarts, no need to re-login
- **Window state memory** — Remembers size and position between launches
- **External link handling** — Links shared in chats open in your default browser; Facebook redirect URLs (`l.facebook.com`) are unwrapped automatically
- **Dark mode** — Syncs with your system appearance
- **macOS native menu bar** — Full menu with keyboard shortcuts
- **System tray** — Quick access from the menu bar (macOS)
- **Download handling** — Files save to Downloads with dock progress bar and completion notification
- **Media permissions** — Camera, microphone, and screen sharing for video/audio calls
- **Draggable title bar** — macOS hidden inset traffic lights with a draggable top strip
- **Cross-platform** — Builds for macOS (universal binary) and Windows (x64)

## Download

Get the latest release from [GitHub Releases](https://github.com/iliogr/facebook-messenger/releases/latest):

| Platform | File | Architecture |
|----------|------|-------------|
| macOS | `Messenger-x.x.x-universal.dmg` | Intel + Apple Silicon |
| Windows | `Messenger.Setup.x.x.x.exe` | x64 |

### macOS: "Apple could not verify" warning

If macOS shows a Gatekeeper warning when you first open the app:

1. Open **System Settings** > **Privacy & Security**
2. Scroll down to the "Messenger was blocked" message
3. Click **Open Anyway**

Alternatively: right-click the app > **Open** > click **Open** in the dialog. This only needs to be done once.

## Requirements

- [Node.js](https://nodejs.org/) >= 18
- npm

## Quick Start

```bash
# Install dependencies
make install

# Run in development mode
make start
```

## Building

### Code Signing & Notarization (macOS)

To produce a signed and notarized build that doesn't trigger Gatekeeper warnings:

1. Install a **Developer ID Application** certificate in your Keychain (from [developer.apple.com](https://developer.apple.com/account))
2. Generate an app-specific password at [appleid.apple.com](https://appleid.apple.com/account/manage) > Sign-In and Security > App-Specific Passwords
3. Set environment variables:

```bash
cp .env.example .env
# Edit .env with your credentials, then:
source .env
```

electron-builder will automatically sign and notarize the macOS build when these credentials are available.

### Build Commands

```bash
# Build for macOS (.dmg, universal: Intel + Apple Silicon)
make build-mac

# Build for Windows (.exe, x64 NSIS installer)
make build-win

# Build for all platforms
make build
```

Build output goes to `dist/`:

| Platform | File | Architecture |
|----------|------|-------------|
| macOS | `Messenger-<version>-universal.dmg` | Intel + Apple Silicon |
| Windows | `Messenger Setup <version>.exe` | x64 |

## Installing

### macOS
Open the `.dmg` and drag **Messenger** to your Applications folder.

### Windows
Run `Messenger Setup <version>.exe` and follow the installer prompts. You can choose the installation directory.

## Project Structure

```
messenger/
├── main.js              # Main process — window, menus, tray, IPC, permissions
├── preload.js           # Preload script — title bar CSS, notifications, badge detection
├── package.json         # Dependencies and electron-builder config
├── entitlements.plist   # macOS entitlements (camera, mic, network)
├── Makefile             # Build commands
├── assets/
│   ├── icon.png             # 1024x1024 app icon
│   ├── icon.svg             # Source SVG icon
│   ├── trayIconTemplate.png # 22x22 macOS tray icon (Template image)
│   └── trayIconTemplate.svg # Source SVG tray icon
└── dist/                # Build output (gitignored)
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Q` | Quit |
| `Cmd+W` | Hide window |
| `Cmd+H` | Hide app |
| `Cmd+,` | Preferences |
| `Cmd+R` | Reload |
| `Cmd+Shift+R` | Force reload |
| `Cmd+[` / `Cmd+]` | Back / Forward |
| `Cmd++` / `Cmd+-` | Zoom in / out |
| `Cmd+0` | Reset zoom |
| `Ctrl+Cmd+F` | Toggle fullscreen |
| `Cmd+Option+I` | Developer tools |

## macOS Behavior

- **Close button** (red traffic light) hides the window — the app stays in the dock
- **Cmd+Q** fully quits the app
- Clicking the dock icon re-shows the window
- Tray icon in the menu bar toggles window visibility

## How It Works

The app loads `https://www.facebook.com/messages/` in an Electron `BrowserWindow` with a persistent session partition. A preload script bridges the web page and native APIs:

- **Notifications**: `window.Notification` is overridden to forward calls via IPC to Electron's native `Notification` API
- **Badge count**: A `MutationObserver` watches the page title and DOM for unread indicators, forwarding counts to `app.dock.setBadge()`
- **Navigation**: URLs are intercepted — Messenger paths stay in-app, everything else opens in the default browser
- **Facebook redirects**: `l.facebook.com/l.php?u=` URLs are unwrapped to open the actual destination externally

## Configuration

Session data (cookies, localStorage) is stored in Electron's `userData` directory under the `persist:messenger` partition. Window state is saved to `window-state.json` in the same directory.

To reset all data:
```bash
# macOS
rm -rf ~/Library/Application\ Support/Messenger

# Windows
rmdir /s "%APPDATA%\Messenger"
```

## Releasing

```bash
# Bump version + build all platforms
make release-patch   # 1.0.2 -> 1.0.3
make release-minor   # 1.0.2 -> 1.1.0
make release-major   # 1.0.2 -> 2.0.0

# Push and create GitHub release
make publish
```

## License

MIT
