# klogs — Kubernetes Log Watcher

A tiny, single-binary web app for tailing, viewing, and downloading logs from
Kubernetes workloads. Point it at a kubeconfig, pick a cluster context and a
namespace, pick a Deployment/Service/Pod, click, watch logs stream live.

No auth, no RBAC UI, no metrics, no log storage/search backend — this is a
convenience tool for local/dev use on top of `kubectl`-equivalent access.

## Goals

- Single Go binary, no external runtime deps.
- Serves a web UI on a local port (default `:8080`).
- Uses the existing kubeconfig (`~/.kube/config` or `$KUBECONFIG`) —
  same contexts/clusters/auth `kubectl` already uses. No credential entry in
  the UI.
- List contexts → namespaces → workloads (Deployments, and Services mapped to
  their backing pods) → pods → containers.
- Stream logs live in the browser (tail -f style) for a selected pod/container.
- Download logs (full available log, or the currently buffered stream) as a
  `.log` file.
- Multi-platform builds (linux/darwin/windows, amd64/arm64) built and
  released via GitHub Actions on tag push.

## Non-goals

- No log aggregation, indexing, or search across pods/time (use Loki/etc for
  that).
- No general cluster write access (no `create`/`delete`/`exec`, no editing
  resource specs). The one deliberate exception is restarting a Deployment
  (or the Deployment behind a Service) from the UI — see
  [Restarting workloads](#restarting-workloads) below.
- No multi-user auth/session model. If exposed beyond localhost, put it
  behind your own reverse proxy / auth.
- No persistence — nothing is stored server-side beyond in-memory buffers
  needed to serve a download of the currently-streamed log. UI preferences
  (theme) are stored client-side only, in `localStorage`.

## Architecture

Single Go process:

- **HTTP server** (`net/http` + `gorilla/websocket` or `nhooyr.io/websocket`)
  serves both the REST API and the static frontend (embedded via
  `embed.FS`).
- **Kubernetes client** built with `client-go`, loaded via
  `clientcmd.NewNonInteractiveDeferredLoadingClientConfig`, which honors
  `$KUBECONFIG` and `~/.kube/config` exactly like `kubectl`.
- **Frontend**: a single static HTML/CSS/vanilla-JS page (no build step, no
  node_modules) embedded into the binary with `//go:embed`. Keeps the
  toolchain to just Go.

```
+-------------------+        +----------------------+
|  Browser (UI)     | <----> |  Go binary (klogs)    |
|  - context picker |  HTTP  |  - REST API           |
|  - namespace list |  /WS   |  - client-go informer |
|  - workload list  |        |    /pod log stream     |
|  - log viewer     |        |  - embedded static UI  |
+-------------------+        +----------+-----------+
                                         |
                                         v
                              +----------------------+
                              |  Kubernetes API       |
                              |  (via kubeconfig ctx)  |
                              +----------------------+
```

### Why client-go instead of shelling out to `kubectl`

Avoids a runtime dependency on `kubectl` being installed/on PATH, gives
typed access to the API, and lets us use the SDK's log-streaming call
(`clientset.CoreV1().Pods(ns).GetLogs(...).Stream(ctx)`) directly.

## REST API

All under `/api`. JSON responses.

| Method | Path | Description |
|---|---|---|
| GET | `/api/version` | `{"version": "..."}` — same string as `klogs --version`, used by the splash screen. |
| GET | `/api/contexts` | List kubeconfig contexts + which is current. |
| GET | `/api/namespaces?context=` | List namespaces in the selected context. |
| GET | `/api/workloads?context=&namespace=` | List Deployments and Services in the namespace, each with pod count/ready status. |
| GET | `/api/workloads/{kind}/{name}/pods?context=&namespace=` | List pods backing a Deployment (by selector) or a Service (by endpoint/selector), with container names. |
| POST | `/api/workloads/{kind}/{name}/restart?context=&namespace=` | Restart a Deployment (or the Deployment behind a Service — see below). |
| GET | `/api/pods?context=&namespace=` | List all pods in namespace (flat list, for direct pod selection). |
| GET | `/ws/logs?context=&namespace=&pod=&container=&follow=true&tailLines=500&previous=false` | WebSocket: streams log lines live. |
| GET | `/api/logs/download?context=&namespace=&pod=&container=&tailLines=&previous=` | Streams the log as a file attachment (`Content-Disposition: attachment`), same underlying call as above but `Stream: false`/plain HTTP chunked response, no WS. |

Notes:
- `kind` is `deployment` or `service`.
- For a Service, pods are resolved via the Service's `spec.selector` (falls
  back to listing `Endpoints`/`EndpointSlice` if the selector is empty).
- Multi-container pods: container must be explicitly selected; API lists
  containers so the UI can offer a dropdown when a pod has more than one.
- `previous=true` maps to `Previous: true` in `PodLogOptions`, for viewing a
  crashed container's last logs.

## Restarting workloads

The one write operation klogs performs: `POST /api/workloads/{kind}/{name}/restart`
triggers a rolling restart the same way `kubectl rollout restart` does — it
patches `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]`
on the Deployment with the current timestamp, which the Deployment
controller picks up and rolls pods over for.

- `kind=deployment`: patches that Deployment directly.
- `kind=service`: klogs resolves the Service's backing pods (same selector
  logic as the pods endpoint), walks each pod's owner chain
  (`Pod -> ReplicaSet -> Deployment`), and restarts the single Deployment
  found. If the pods trace back to more than one Deployment (or none/an
  unrecognized owner), the request fails with an explanatory error instead
  of guessing.
- The UI always shows a confirmation dialog before sending the request,
  since this changes live cluster state and isn't reversible by clicking
  again.

Everything else in the API stays read-only (`list`/`get`/`get log`).

## Log streaming

- WebSocket handler opens `clientset.CoreV1().Pods(ns).GetLogs(pod, &opts)`
  with `Follow: true` and pipes each read chunk to the client as a text
  message, line-buffered.
- On client disconnect, the context passed to the k8s API call is canceled,
  stopping the underlying stream (no server-side leaks).
- Reconnect on transient errors is left to the frontend (simple "stream
  ended, click to resume" button) — no auto-retry loop server-side.
- Download endpoint reuses the same log-fetch path with `Follow: false` and
  a configurable `tailLines` (default: all available, i.e. omit tailLines
  unless the user set a limit) streamed straight through to the HTTP
  response as it's read — no full buffering in memory, so large logs don't
  balloon RSS.

## Frontend (single page)

Layout, top to bottom:

0. **Splash screen**: shown on every page load, dismissed by its button,
   Escape/any key, a backdrop click, or automatically after 6s. Shows an
   original SVG logo (an abstract "log lines" mark, not the Kubernetes
   logo), the running version (fetched from `/api/version`), the keyboard
   shortcut legend, and a "Designed by Rajendra Khope /
   rajendrakhope.com" credit line. It's decoration on top of the already-
   loading app underneath, not a gate — the context/namespace/etc. fetches
   in `init()` proceed in parallel regardless of whether it's dismissed.
1. **Top filter bar**: a cascading chain of dropdowns — context → namespace
   → workload (Deployment/Service, shown as `[d]`/`[s]`) → pod → container
   (only shown when the pod has more than one container) — plus a
   light/dark theme toggle. Context and namespace selections are persisted
   in `localStorage` and restored on the next load (falling back to the
   kubeconfig's current context / the `default` namespace if the saved
   value no longer exists). Each select repopulates/resets the ones after
   it when changed.
2. **Auto-opening logs**: picking a pod (or, for multi-container pods,
   picking/confirming a container) immediately opens a new log tab for it —
   there's no separate "open logs" button. Picking a different container
   for the same pod opens another tab, so multiple containers/pods can be
   compared side by side. New tabs start at the tail of the log (see
   below), not the full history, so they land where the action is.
3. **Log viewer tabs**: one per pod/container, each with its own WebSocket
   connection, each snapshotting the context/namespace/workload/pod/
   container it was opened with (so it stays correct even if the filter bar
   selection changes afterward).
   - The tab strip shows each tab's title with its own close (×) button on
     the tab itself, plus a "close all" button for the whole strip.
   - Toolbar per tab, in order: **Show last** (100/1000/2000/4000/All)
     dropdown, **now** button, "previous container logs" toggle,
     autoscroll on/off, word-wrap on/off, full screen, clear, download,
     **restart** (restarts the Deployment/Service this tab's pod belongs
     to, behind a confirmation prompt).
   - Keyboard shortcuts (active tab, not while typing in a field): `a`
     autoscroll, `w` word wrap, `f` full screen, `r` restart (still
     confirms before acting).
   - Scrolling away from the bottom auto-pauses autoscroll (so a busy pod
     doesn't yank you back down while reading history); scrolling back to
     the bottom resumes it. This is on top of the manual autoscroll toggle,
     not a replacement for it.

### Tailing, buffering, and the "Show last" control

Two related problems this addresses:

- **Starting at the tail, not the whole history.** A new tab passes
  `tailLines` equal to the "Show last" selection (default 1000) when
  connecting, so it starts near the end of the log and streams forward
  from there, instead of pulling the pod's entire log history on open.
  The **now** button reconnects with `tailLines=0` for one connection
  (skip all history, follow only what's written from this moment on)
  without changing the dropdown's setting for later reconnects.
- **Bounded memory during long-running tabs.** Each incoming line is
  appended as its own DOM text node (`appendChild`), and once the tab has
  more lines than the "Show last" setting, the oldest ones are dropped
  from the front (`removeChild`) — a simple ring buffer. This replaced an
  earlier implementation that did `view.textContent += line`, which
  re-serializes the entire buffer on every single incoming line (O(n) per
  line, so O(n²) over a session) and was the root cause of tabs — and the
  whole page, since a busy tab's rendering starves the same main thread
  the dropdown `change` handlers run on — becoming unresponsive after
  running a while. Selecting **All** disables the cap (matches the old
  unbounded behavior) as an explicit opt-in.
- **Download is unaffected by any of this.** The download endpoint is a
  fresh request straight to `GetLogs` on the server side — it always
  returns the complete available log regardless of what the tab's "Show
  last" cap or live buffer currently holds.

### Restart and pod replacement

A Deployment restart destroys and recreates its pods under new names, so
after a tab's restart button succeeds, klogs polls
`/api/workloads/{kind}/{name}/pods` (every 2s, up to ~30s) for a pod name
that wasn't present before the restart and is `Running`. Once found:

- If the top filter bar is still pointed at that same
  context/namespace/workload, its Pod dropdown is refreshed and set to the
  new pod.
- A new log tab is opened automatically for the new pod (same container
  name if it still exists, else the new pod's first container). The old
  tab is left as-is — it naturally shows "disconnected" once its pod is
  gone, and it still holds whatever it had buffered, so nothing is lost by
  not closing it automatically.

No frontend framework, no build tooling — plain HTML/CSS/JS served from
`web/static/` and embedded with `go:embed` at compile time.

## Project layout

```
klogs/
├── cmd/klogs/
│   └── main.go              # flag parsing, server bootstrap
├── internal/
│   ├── k8s/
│   │   ├── client.go        # kubeconfig loading, per-context clientset cache
│   │   ├── workloads.go     # list namespaces/deployments/services/pods
│   │   ├── logs.go          # log stream/download helpers
│   │   └── restart.go       # rolling-restart a deployment/service
│   └── server/
│       ├── server.go        # http.Handler wiring, embed.FS mount
│       ├── api.go           # REST handlers
│       └── ws.go            # websocket log handler
├── web/
│   └── static/
│       ├── index.html
│       ├── app.js
│       └── style.css
├── docs/
│   └── screenshot.png       # README screenshot
├── .github/workflows/
│   ├── ci.yml                # build+vet+test on PR/push
│   └── release.yml           # auto-semver tag + goreleaser on push to main
├── .goreleaser.yaml
├── install.sh                # curl | bash installer (macOS/Linux/Git-Bash/WSL)
├── install.ps1                # native Windows PowerShell installer
├── go.mod
├── go.sum
├── design.md
└── README.md
```

## CLI / configuration

Single binary `klogs`, flags (all optional):

```
klogs [flags]

  --port int          Port to serve the web UI on (default 8080)
  --kubeconfig string Path to kubeconfig (default: $KUBECONFIG or ~/.kube/config)
  --addr string       Bind address (default "127.0.0.1")
  --open              Open the web UI in the default browser once the server starts
  --version           Print version and exit
```

On startup: parses kubeconfig, binds the listening socket, prints the URL,
and — if `--open` was passed — launches it in the OS default browser
(`open` on macOS, `rundll32 url.dll,FileProtocolHandler` on Windows,
`xdg-open` elsewhere) before serving.

## Key dependencies

- `k8s.io/client-go`, `k8s.io/api`, `k8s.io/apimachinery` — cluster access.
- `k8s.io/client-go/tools/clientcmd` — kubeconfig loading (context list,
  switching).
- A small websocket lib (`github.com/coder/websocket` or
  `github.com/gorilla/websocket`) — log streaming.
- Standard library `net/http`, `embed` for everything else.
- No ORM, no database, no session store.

## Build & Release (GitHub Actions)

Two workflows:

### `ci.yml` — on every push/PR
- `go build ./...`
- `go vet ./...`
- `go test ./...`
- (optional) `golangci-lint run`

### `release.yml` — automatic semver release on every push to `main`
- Computes the next version by reading the latest `vX.Y.Z` git tag and
  bumping it: **patch** by default, or **minor**/**major** if the
  triggering commit message contains `[minor]`/`[major]`. If no tag exists
  yet, it starts at `v0.1.0`. A commit message containing `[skip release]`
  skips the job entirely.
- Creates and pushes that tag, then runs
  [GoReleaser](https://goreleaser.com/) to cross-compile and publish a
  GitHub Release with binaries attached — all in the same workflow run (so
  it isn't relying on the tag push re-triggering a second workflow, which
  the default `GITHUB_TOKEN` can't do).
- Also triggers on a manually pushed `v*` tag (skipping the auto-bump
  step) and on manual `workflow_dispatch`, for cutting an out-of-band
  release.

`.goreleaser.yaml` targets:

```yaml
builds:
  - id: klogs
    main: ./cmd/klogs
    env: [CGO_ENABLED=0]
    goos: [linux, darwin, windows]
    goarch: [amd64, arm64]
archives:
  - format: tar.gz
    format_overrides:
      - goos: windows
        format: zip
checksum:
  name_template: "checksums.txt"
release:
  github:
    owner: bkrajendra
    name: klogs
```

Resulting release artifacts per tag (e.g. `v0.1.0`):
- `klogs_linux_amd64.tar.gz`, `klogs_linux_arm64.tar.gz`
- `klogs_darwin_amd64.tar.gz`, `klogs_darwin_arm64.tar.gz`
- `klogs_windows_amd64.zip`, `klogs_windows_arm64.zip`
- `checksums.txt`

The binary's `--version` output is set via `-ldflags -X main.version={{.Version}}`
in `.goreleaser.yaml`, so it always reports the exact tag it was built from.

Every push to `main` therefore produces a new tagged release automatically;
no manual tagging or build step is required.

## Distribution

Two installer scripts at the repo root, meant to be run via
`curl ... | bash` / `irm ... | iex` straight from `raw.githubusercontent.com`
(no separate package-manager tap/bucket to maintain):

- `install.sh` — macOS, Linux, and Windows under Git Bash/WSL/MSYS. Detects
  OS/arch via `uname`, resolves the latest release tag from the GitHub API
  (or honors `KLOGS_VERSION` to pin one), downloads the matching archive
  and `checksums.txt`, verifies the SHA-256 checksum, extracts the binary,
  and installs it to `/usr/local/bin` (if writable) or `~/.local/bin`
  (override with `KLOGS_INSTALL_DIR`). Never uses `sudo` — if neither
  target is writable/on `PATH`, it prints the `export PATH=...` line to
  add.
- `install.ps1` — native Windows PowerShell equivalent: same
  download/verify/extract flow, installs to
  `%LOCALAPPDATA%\Programs\klogs` (override with `KLOGS_INSTALL_DIR`), and
  appends that directory to the user's `PATH` via
  `[Environment]::SetEnvironmentVariable(..., "User")`.

Both scripts are read-only with respect to the system beyond writing the
one binary and (on Windows) one user-scope PATH entry — no admin/sudo
elevation, no package manager registration.

## Security notes

- Binds to `127.0.0.1` by default — not exposed on the network unless the
  user explicitly passes `--addr 0.0.0.0`.
- Uses whatever access the local kubeconfig context already has; klogs
  itself performs no privilege escalation and does not `exec`, `delete`,
  or `create` anything. The single exception is the restart action
  (`patch` on a Deployment's pod template annotation, gated behind a
  confirmation dialog in the UI) — everything else is `list`/`get`/`get log`.
- No credentials are accepted or stored by the web UI itself; all auth is
  delegated to the kubeconfig's existing auth plugins (exec plugins, OIDC,
  client certs, etc. all work as-is since we use client-go + clientcmd
  unmodified).

## Milestones (suggested build order)

1. `internal/k8s`: context list, namespace list, pod list, log fetch (no
   follow) — verify against a real cluster via a small CLI test.
2. `internal/server`: REST endpoints wrapping the above + embedded static
   `index.html` shell.
3. Frontend: context/namespace/workload picker, static pod list rendering.
4. Log streaming: WS endpoint + frontend viewer with autoscroll.
5. Download endpoint + UI button.
6. Deployment/Service → pod resolution (selector-based).
7. GitHub Actions: `ci.yml`, then `release.yml` + `.goreleaser.yaml`, cut
   `v0.1.0`.
