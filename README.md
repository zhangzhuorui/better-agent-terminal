# Better Agent Terminal

<div align="center">

<img src="assets/icon.svg" width="128" height="128" alt="Better Agent Terminal">

![Version](https://img.shields.io/badge/version-1.37.0-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20|%20macOS%20|%20Linux-lightgrey.svg)
![Electron](https://img.shields.io/badge/electron-28.3.3-47848F.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

**A cross-platform terminal aggregator with multi-workspace support and Claude Code integration**

[Download Latest Release](https://github.com/tony1223/better-agent-terminal/releases/latest)

</div>

---

## Screenshot

<div align="center">
<img src="assets/screenshot.png" alt="Better Agent Terminal Screenshot" width="800">
</div>

---

## Features

### Workspace Management
- **Multi-Workspace** — Organize terminals by project folders
- **Drag & Drop** — Reorder workspaces freely
- **Groups** — Categorize workspaces with filter dropdown
- **Detachable Windows** — Pop out workspaces to separate windows, auto-reattach on restart
- **Per-Workspace Env Vars** — Configure environment variables per workspace
- **Activity Indicators** — See which workspaces have running terminals
- **Double-click to rename**, right-click context menu for all actions

### Terminal
- **Google Meet-style layout** — 70% main panel + 30% thumbnail bar
- **Multiple terminals per workspace** — xterm.js with full Unicode/CJK support
- **Tab navigation** — Terminal / Files / Git views
- **File browser** — Search, navigate, preview files with syntax highlighting
- **Git integration** — Diff viewer, branch display, untracked files, GitHub link detection
- **Snippet manager** — Save, organize, and paste code snippets

### Claude Code Agent
- **Built-in Claude Code** via SDK — no separate terminal needed
- **Message streaming** with extended thinking (collapsible)
- **Permission-based tool execution** with bypass mode
- **Active tasks bar** — See running operations with elapsed time
- **Session resume** — Persist and resume conversations across restarts
- **Rest/Wake sessions** — Pause and resume agent sessions from context menu
- **Statusline** — Token usage, cost, context window %, model, git branch, duration
- **Prompt history** — View and copy all user prompts from statusline
- **Image attachment** — Drag-drop or button (max 5 images)
- **Clickable URLs** — Markdown links and bare URLs open in default browser
- **Clickable file paths** — Preview files with syntax highlighting, search (Ctrl+F)
- **Ctrl+P file picker** — Search and attach files to context

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+P` / `Cmd+P` | File picker (search & attach files) |
| `Shift+Tab` | Switch between Terminal and Agent mode |
| `Enter` | Send message |
| `Shift+Enter` | Insert newline (multiline input) |
| `Escape` | Stop streaming / close modal |
| `Ctrl+Shift+C` | Copy selected text |
| `Ctrl+Shift+V` | Paste from clipboard |
| `Right-click` | Copy (if selected) or Paste |

## Slash Commands

| Command | Description |
|---|---|
| `/resume` | Resume a previous Claude session |
| `/model` | Switch between available models |

---

## Quick Start

### Option 1: Download Release

Download from [Releases](https://github.com/tony1223/better-agent-terminal/releases/latest) for your platform:

| Platform | Format |
|---|---|
| Windows | NSIS installer, `.zip` |
| macOS | `.dmg` (universal binary) |
| Linux | `.AppImage` |

**macOS DMG installation:**

1. Download the `.dmg` file from Releases
2. Double-click the `.dmg` to mount it
3. Drag **Better Agent Terminal** into the **Applications** folder
4. On first launch, macOS may block the app — go to **System Settings > Privacy & Security**, scroll down and click **Open Anyway**
5. Make sure [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) is installed (`npm install -g @anthropic-ai/claude-code`)

### Option 2: Build from Source

**Prerequisites:**
- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

```bash
git clone https://github.com/tony1223/better-agent-terminal.git
cd better-agent-terminal
npm install
```

**Development mode:**
```bash
npm run dev
```

**Build for production:**
```bash
npm run build
```

### macOS Build Notes

Native dependencies (`node-pty`, `better-sqlite3`) require Xcode Command Line Tools:

```bash
xcode-select --install
```

Then:

```bash
npm install
npm run dev      # Development
npm run build    # Build .dmg
```

---

## Architecture

```
better-agent-terminal/
├── electron/
│   ├── main.ts                 # Electron main process, window management
│   ├── preload.ts              # IPC bridge
│   ├── pty-manager.ts          # PTY process management (multi-window broadcast)
│   └── claude-agent-manager.ts # Claude SDK session management
├── src/
│   ├── components/
│   │   ├── Sidebar.tsx         # Workspace list, groups, context menu
│   │   ├── WorkspaceView.tsx   # Main workspace container
│   │   ├── ClaudeAgentPanel.tsx# Claude Code agent UI
│   │   ├── TerminalPanel.tsx   # xterm.js terminal
│   │   ├── ThumbnailBar.tsx    # Terminal thumbnail list
│   │   ├── PathLinker.tsx      # Clickable paths & URLs, file preview modal
│   │   └── SnippetSidebar.tsx  # Snippet manager
│   ├── stores/
│   │   ├── workspace-store.ts  # Workspace state management
│   │   └── settings-store.ts   # App settings
│   ├── types/
│   │   ├── index.ts            # Core types
│   │   └── claude-agent.ts     # Claude message types
│   └── styles/
│       ├── main.css
│       ├── claude-agent.css
│       └── path-linker.css
└── package.json
```

### Tech Stack
- **Frontend:** React 18 + TypeScript
- **Terminal:** xterm.js + node-pty
- **Framework:** Electron 28
- **AI:** @anthropic-ai/claude-agent-sdk
- **Build:** Vite + electron-builder
- **Storage:** better-sqlite3

---

## Remote Access & Mobile Connect

BAT 內建 WebSocket Server，允許其他 BAT 實例或行動裝置遠端連線控制。此功能目前為**實驗性質**。

### 運作原理

1. **Host（主機端）** 在 Settings → Remote Access 啟動 WebSocket Server（預設 port 9876）
2. Server 啟動時產生一組 **Connection Token**（32 字元 hex），用於驗證連線身份
3. **Client（連線端）** 透過 Remote Profile 輸入主機 IP、Port、Token 即可連入
4. 連線後 Client 可操作主機上的所有 Terminal、Claude Agent、Workspace 等功能

### 連線方式

#### 方式一：Remote Profile（BAT 對 BAT）

在 Client 端的 BAT：

1. 開啟 Settings → Profiles
2. 建立新 Profile，類型選 **Remote**
3. 填入 Host IP、Port（9876）、Token
4. 載入該 Profile 即連上遠端主機

#### 方式二：QR Code（行動裝置）

在 Host 端的 BAT：

1. 開啟 Settings → Remote Access → **Generate QR Code**
2. 若 Server 未啟動會自動啟動
3. 使用行動裝置掃描 QR Code 即可取得連線資訊
4. QR Code 內含 WebSocket URL 與 Token（JSON 格式）

### 推薦使用 Tailscale 進行跨網段連線

若 Host 與 Client 不在同一個區域網路（例如在家連公司電腦），建議使用 [Tailscale](https://tailscale.com/) 建立安全的點對點 VPN：

- **免費方案**支援最多 100 台裝置
- 不需要設定 port forwarding 或架設額外伺服器
- 每台裝置會取得一個固定的 `100.x.x.x` IP
- BAT 會自動偵測 Tailscale IP 並優先使用

**安裝方式：**

| 平台 | 安裝 |
|------|------|
| macOS | [Download](https://tailscale.com/download/macos) 或 `brew install tailscale` |
| Windows | [Download](https://tailscale.com/download/windows) |
| iOS | [App Store](https://apps.apple.com/app/tailscale/id1470499037) |
| Android | [Google Play](https://play.google.com/store/apps/details?id=com.tailscale.ipn) |
| Linux | [Install Guide](https://tailscale.com/download/linux) |

安裝後登入同一帳號，所有裝置即可互通。BAT 的 QR Code 會自動使用 Tailscale IP。

### 安全注意事項

> **⚠ 警告：** 啟動 Remote Server 會開放 WebSocket 連線，任何持有 Token 的裝置皆可完整控制此主機上的 BAT，包括執行終端指令、操作檔案系統、控制 Claude Agent 等。
>
> - 請勿在不信任的網路環境下啟動 Server
> - 請勿將 Token 分享給不信任的人
> - 不使用時請關閉 Server
> - 強烈建議搭配 Tailscale 使用，避免直接暴露在公網

---

## Configuration

Workspaces and settings are saved to:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%/better-agent-terminal/` |
| macOS | `~/Library/Application Support/better-agent-terminal/` |
| Linux | `~/.config/better-agent-terminal/` |

---

## Release

### Version Format

Version follows: `1.YY.MMDDHHmmss`

Example: `v1.25.1219091538` = 2025-12-19 09:15:38

### Automated Release (GitHub Actions)

Push a tag to trigger builds for all platforms:

```bash
git tag v1.37.0
git push origin v1.37.0
```

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Author

**TonyQ** - [@tony1223](https://github.com/tony1223)

## Contributors

- **lmanchu** - [@lmanchu](https://github.com/lmanchu) - macOS/Linux support, workspace roles
- **bluewings1211** - [@bluewings1211](https://github.com/bluewings1211) - Shift+Enter newline, preserve workspace state, font settings
- **Henry Hu** - [@ninedter](https://github.com/ninedter) - Key API discovery and valuable architectural feedback

---

<div align="center">

Built with Claude Code

</div>
