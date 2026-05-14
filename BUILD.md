# Build Guide — Cross-Platform Packaging

This guide covers how to build BetterAgentTerminal for **macOS**, **Windows**, and **Linux**.

## Prerequisites

- **Node.js 20+** (LTS recommended)
- **npm 10+**
- **Python 3.x** (required by `node-gyp` for compiling native modules)
- Platform-specific build tools:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Windows**: Visual Studio Build Tools or Visual Studio Community (with "Desktop development with C++" workload)
  - **Linux**: `build-essential`, `libkrb5-dev`, `rpm` (for RPM packaging)

## Install Dependencies

```bash
npm install
```

## Rebuild Native Modules for Electron

Native modules (`better-sqlite3`, `@lydell/node-pty`) must be recompiled for Electron's Node.js ABI before packaging:

```bash
npm run rebuild:native
```

> **Note**: Run this whenever you switch Electron versions or clone the repository fresh.

## Build for Current Platform

```bash
# Compile renderer + main process, then package
npm run build
```

## Build for Specific Platforms

### macOS (.dmg)

```bash
npm run build:mac
```

Output: `release/BetterAgentTerminal-*.dmg`

The default target is a **universal** binary (x64 + arm64). If you only need the current architecture, edit `mac.target` in `package.json`:

```json
"mac": {
  "target": {
    "target": "dmg",
    "arch": ["x64"]  // or ["arm64"]
  }
}
```

### Windows (.exe installer + .zip)

```bash
npm run build:win
```

Output:
- `release/BetterAgentTerminal Setup *.exe` (NSIS installer)
- `release/BetterAgentTerminal *.zip` (portable)

### Linux (AppImage)

```bash
npm run build:linux
```

Output: `release/BetterAgentTerminal-*.AppImage`

## Cross-Platform Limitations

**electron-builder can only build for the current operating system natively** (with one exception: macOS can build for both x64 and arm64).

| Build Host | Can Target |
|------------|------------|
| macOS | macOS (x64, arm64, universal) |
| Windows | Windows (x64, ia32) |
| Linux | Linux (AppImage, deb, rpm) |

To produce packages for **all three platforms**, use the GitHub Actions CI workflow (`.github/workflows/release.yml`) or set up VMs for each platform.

## Local Unsigned Builds (macOS)

For local testing without an Apple Developer certificate:

1. Set the environment variable before building:
   ```bash
   export CSC_IDENTITY_AUTO_DISCOVERY=false
   npm run build:mac
   ```
2. Or disable code signing in `package.json`:
   ```json
   "mac": {
     "identity": null
   }
   ```

The existing config already has `forceCodeSigning: false`, so unsigned local builds will succeed with a warning.

## CI/CD (GitHub Actions)

The repository includes two workflows:

### Workflow 1: Commit-triggered build (`.github/workflows/build-packages.yml`)

**Trigger**: Push to `main` with commit message containing `[build]`

This workflow builds **macOS** and **Windows** packages in parallel, then creates/updates a GitHub Release using the version from `package.json`.

**How to use:**
```bash
git add .
git commit -m "feat: update UI [build]"
git push origin main
```

GitHub Actions will:
1. Build macOS `.dmg` + `.zip` on `macos-latest`
2. Build Windows `.exe` + `.zip` on `windows-latest`
3. Upload both to a GitHub Release named after `package.json` version (e.g. `v2.0.9`)

> If the release tag already exists, the workflow will update it with the new artifacts.

### Workflow 2: Tag-triggered release (`.github/workflows/release.yml`)

**Trigger**: Push a version tag starting with `v`

This workflow builds for **all three platforms** (Windows, macOS, Linux) and creates a full release with Homebrew tap update.

```bash
git tag v2.1.0
git push origin v2.1.0
```

### Required Secrets (for macOS code signing + notarization)

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE_P12` | Base64-encoded Apple Developer ID certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Certificate password |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `TAP_GITHUB_TOKEN` | Token for Homebrew tap updates (optional, tag workflow only) |

For local/internal builds without code signing, these secrets are not required. The commit-triggered workflow will automatically detect missing secrets and build unsigned macOS packages.

## Troubleshooting

### "Cannot find module" for native dependencies

Run `npm run rebuild:native` again. If it fails:

```bash
# Clean and rebuild
rm -rf node_modules/@lydell/node-pty/build
npm run rebuild:native
```

### Windows: "gyp ERR! find VS"

Install Visual Studio Build Tools with the **Desktop development with C++** workload, then:

```bash
npm config set msvs_version 2022
npm run rebuild:native
```

### macOS: "not valid for use in process" (library validation)

The `build/entitlements.mac.plist` already includes `com.apple.security.cs.disable-library-validation`. If you see this error on Apple Silicon, ensure `@electron/rebuild` ran successfully after `npm install`.

### Large package size

The `asarUnpack` array in `package.json` extracts heavy native modules from the ASAR archive so Electron can load their `.node` binaries. This is required for:
- `better-sqlite3`
- `@lydell/node-pty`
- `@anthropic-ai/claude-code`
- `@anthropic-ai/claude-agent-sdk`
- `codeburn` (optional)

To inspect the final package contents:

```bash
npx asar list release/mac/BetterAgentTerminal.app/Contents/Resources/app.asar
```
