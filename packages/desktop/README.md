# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

### Windows portable package

Set the channel for both the build and packaging steps. Production builds use
the existing `opencode.db`; development and beta builds use channel-specific
databases such as `opencode-dev.db` and `opencode-beta.db`. Changing the channel
can therefore make existing sessions appear to be missing even though they are
still present in another database.

PowerShell:

```powershell
$env:OPENCODE_CHANNEL = "prod"
bun run build
bun run package:win:portable
```

Bash:

```bash
OPENCODE_CHANNEL=prod bun run build
bun run package:win:portable
```

The portable package is written to `dist/opencode-desktop-win-x64.exe`.

If that executable is currently running, package to a temporary name and use
the replacement script to stop it, wait five seconds, replace it, and restart:

```powershell
.\scripts\replace-portable.ps1
```

By default, the script replaces `dist/opencode-desktop-win-x64.exe` with
`dist/opencode-desktop-win-x64-prod.exe`. Use `-Source`, `-Target`, or
`-DelaySeconds` to override those values.
