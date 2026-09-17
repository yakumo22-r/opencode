# Windows Portable Packaging

Use this standard when building the fork's daily-use Windows executable.

## Required behavior

- The portable build must use the production channel: `OPENCODE_CHANNEL=prod`.
- It must retain the official runtime identity: `OpenCode` and `ai.opencode.desktop`.
- It shares the official application data at `%APPDATA%\ai.opencode.desktop`, including workspaces, sessions, tabs, settings, and the bundled server state.
- The fork differs from the official build only through its bundled code. It does not have a separate `OpenCode Dev` identity or data directory.
- Do not run the official installation and fork portable executable at the same time. The desktop application starts one local sidecar server per Electron process, and concurrent processes can contend for the same state files.

## Build

Run from `packages/desktop` in Bash:

```bash
ELECTRON_GET_USE_PROXY=true bun run build
ELECTRON_GET_USE_PROXY=true bun run package:win:portable
```

The proxy variable is only needed on networks where Electron downloads require it.

## Output

Use this file for the portable release:

```text
packages/desktop/dist/opencode-desktop-win-x64.exe
```

Electron Builder also produces an unpacked diagnostic build at:

```text
packages/desktop/dist/win-unpacked/OpenCode.exe
```

The portable executable is not installed into `%LOCALAPPDATA%\Programs`; it runs from wherever the file is placed.

## Verification

Before distributing or replacing a daily-use executable:

1. Close all OpenCode windows.
2. Start `dist/opencode-desktop-win-x64.exe`.
3. Confirm it shows the same existing workspaces and sessions as the official installation.
4. Confirm `Ctrl+Shift+Space` opens and closes the session index.
5. Confirm a normal prompt can be sent successfully.
