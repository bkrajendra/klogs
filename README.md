# klogs

A tiny, single-binary web app for browsing Kubernetes Deployments/Services
and tailing or downloading their pod logs — using your existing kubeconfig.

![klogs screenshot](docs/screenshot.png)

See [design.md](design.md) for the full spec.

## Install

macOS, Linux, or Windows via Git Bash/WSL:

```sh
curl -fsSL https://raw.githubusercontent.com/bkrajendra/klogs/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/bkrajendra/klogs/main/install.ps1 | iex
```

Either script downloads the release archive matching your OS/arch, verifies
it against the release's `checksums.txt`, and installs the `klogs` binary
into a directory on your `PATH`:

- `install.sh`: `/usr/local/bin` if writable, else `~/.local/bin`
  (override with `KLOGS_INSTALL_DIR`).
- `install.ps1`: `%LOCALAPPDATA%\Programs\klogs`, added to your user `PATH`
  automatically (override with `KLOGS_INSTALL_DIR`).

Verify it worked from any new terminal:

```sh
klogs --version
klogs --open
```

`--open` starts the server and launches the web UI in your default browser;
without it, klogs still prints the local URL to open once it's listening.

## Update

Three ways, all equivalent:

- **From the web UI** — the version badge next to the theme toggle turns
  into an update indicator when a newer release is out (checked 5s after
  load, then every 30 min); click it, "Update now", then "Restart now"
  once it's done. A floating notification also appears the first time an
  update is found each session.
- **`klogs update`** — downloads, verifies, and installs the latest release
  in place, no browser needed:
  ```sh
  klogs update              # latest
  klogs update --version v0.1.1   # pin a specific version
  ```
  Restart klogs yourself afterward to use it.
- **Re-run the install command** — always installs the latest release:
  ```sh
  curl -fsSL https://raw.githubusercontent.com/bkrajendra/klogs/main/install.sh | bash
  # or, to pin a version:
  KLOGS_VERSION=v0.1.1 curl -fsSL https://raw.githubusercontent.com/bkrajendra/klogs/main/install.sh | bash
  ```
  (`$env:KLOGS_VERSION = "v0.1.1"` before the `irm | iex` line on Windows.)

## Flags

```
--port int          port to serve the web UI on (default 8080)
--addr string        address to bind to (default "127.0.0.1")
--kubeconfig string  path to kubeconfig (default: $KUBECONFIG or ~/.kube/config)
--open               open the web UI in the default browser once the server starts
--version            print version and exit

klogs update [--version vX.Y.Z]   # download, verify, and install a release in place
```

## Features

- **Cascading filter bar** — context, namespace, workload
  (deployment/service), pod, and container selectors. Selecting a pod (or
  a container, for multi-container pods) opens its logs immediately.
  Context and namespace selections persist across sessions.
- **In-app updates** — a version badge indicates when a newer release is
  available. Updates can be applied from the UI, via the `klogs update`
  CLI command, or by re-running the install script.
- **Tail-first log streaming** — new tabs start at the end of the log
  rather than loading full history. A "Show last" control (100 / 1000 /
  2000 / 4000 / All lines) governs both the initial fetch and the
  in-browser buffer size; "now" skips history entirely. Downloads always
  return the complete log regardless of this setting.
- **Multi-tab log viewer** — concurrent WebSocket streams per pod/container,
  with autoscroll, word wrap, and full-screen toggles, each bound to a
  keyboard shortcut (`a`/`w`/`f`) while a tab is active. Tabs can be closed
  individually or all at once.
- **Previous-container logs** for crash-looping pods.
- **Workload restart** — restart the Deployment (or the Deployment behind a
  Service) from the active tab's toolbar (`r` shortcut), with a
  confirmation prompt. klogs detects the replacement pod once it's running
  and opens a tab for it automatically.
- **Light/dark theme**, persisted across sessions.

## Build from source

```sh
go run ./cmd/klogs      # run directly
go build -o klogs ./cmd/klogs   # or build a binary
```

## Releases

Every push to `main` automatically cuts a new release: the workflow bumps
the patch version from the latest `vX.Y.Z` tag (starting at `v0.1.0`),
pushes the new tag, and runs GoReleaser to build linux/darwin/windows
amd64/arm64 binaries and attach them to a GitHub Release.

- Put `[minor]` or `[major]` in a commit message to bump that field
  instead of patch.
- Put `[skip release]` in a commit message to skip releasing for that
  push.
- Pushing a `vX.Y.Z` tag yourself releases exactly that tag, no bump.

See `.github/workflows/release.yml` and `.goreleaser.yaml`.
