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

Re-run the same install command — it always installs the latest release.
To pin a specific version instead:

```sh
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
```

## Features

- Top filter bar: context → namespace → workload (Deployment/Service) →
  pod → container. Picking a pod (or container, for multi-container pods)
  opens its logs immediately — no extra click needed.
- Multi-tab live log streaming (WebSocket) with autoscroll, word-wrap, and
  full-screen toggles — each with a keyboard shortcut (`a`/`w`/`f`) while a
  tab is active. Close a single tab from its own × or clear the whole strip
  with "close all".
- Log download, and a "previous container" toggle for crash-looping pods.
- Restart the Deployment (or the Deployment behind a Service) a tab's pod
  belongs to, right from that tab's toolbar (`r` shortcut), with a
  confirmation prompt first.
- Light/dark theme toggle, persisted locally.

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
