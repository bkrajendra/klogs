# klogs

A tiny, single-binary web app for browsing Kubernetes Deployments/Services
and tailing or downloading their pod logs — using your existing kubeconfig.

See [design.md](design.md) for the full spec.

## Run

```sh
go run ./cmd/klogs
```

Then open http://127.0.0.1:8080 (or pass `--open` to have it opened for you).

Flags:

```
--port int          port to serve the web UI on (default 8080)
--addr string        address to bind to (default "127.0.0.1")
--kubeconfig string  path to kubeconfig (default: $KUBECONFIG or ~/.kube/config)
--open               open the web UI in the default browser once the server starts
--version            print version and exit
```

## Features

- Context/namespace pickers, workload (Deployment/Service) list with
  expandable pod/container view.
- Multi-tab live log streaming (WebSocket) with autoscroll, word-wrap, and
  full-screen toggles — each with a keyboard shortcut (`a`/`w`/`f`) while a
  tab is active. Close a single tab from its own × or clear the whole strip
  with "close all".
- Log download, and a "previous container" toggle for crash-looping pods.
- Restart a Deployment (or the Deployment behind a Service) straight from
  the workload list, with a confirmation prompt first.
- Light/dark theme toggle, persisted locally.

## Build

```sh
go build -o klogs ./cmd/klogs
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
