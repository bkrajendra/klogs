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
- No writing/deleting of cluster resources.
- No multi-user auth/session model. If exposed beyond localhost, put it
  behind your own reverse proxy / auth.
- No persistence — nothing is stored server-side beyond in-memory buffers
  needed to serve a download of the currently-streamed log.

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
| GET | `/api/contexts` | List kubeconfig contexts + which is current. |
| GET | `/api/namespaces?context=` | List namespaces in the selected context. |
| GET | `/api/workloads?context=&namespace=` | List Deployments and Services in the namespace, each with pod count/ready status. |
| GET | `/api/workloads/{kind}/{name}/pods?context=&namespace=` | List pods backing a Deployment (by selector) or a Service (by endpoint/selector), with container names. |
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

1. **Context selector** (dropdown, populated from `/api/contexts`).
2. **Namespace selector** (dropdown, populated on context change).
3. **Workload list** (table: kind, name, ready/available pods) — click a row
   to expand its pod list.
4. **Pod/container picker** — clicking a workload row expands to show its
   pods; clicking a pod shows its containers if more than one.
5. **Log viewer pane**: opens on pod+container click.
   - Streams via WebSocket, auto-scrolls, monospace, dark background.
   - Toolbar: pause/resume autoscroll, clear view, "previous container logs"
     toggle, tail-lines input, download button.
   - Multiple log viewer tabs can be open at once (one per pod/container),
     each with its own WS connection.

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
│   │   └── logs.go          # log stream/download helpers
│   └── server/
│       ├── server.go        # http.Handler wiring, embed.FS mount
│       ├── api.go           # REST handlers
│       └── ws.go            # websocket log handler
├── web/
│   └── static/
│       ├── index.html
│       ├── app.js
│       └── style.css
├── .github/workflows/
│   ├── ci.yml                # build+vet+test on PR/push
│   └── release.yml           # goreleaser on tag push
├── .goreleaser.yaml
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
  --addr string        Bind address (default "127.0.0.1")
```

On startup: parses kubeconfig, prints the URL to open
(`http://127.0.0.1:8080`), and serves.

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

### `release.yml` — on `v*` tag push
- Uses [GoReleaser](https://goreleaser.com/) to cross-compile and publish a
  GitHub Release with binaries attached.

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

Tagging `v0.1.0` and pushing the tag is what triggers `release.yml`; no
manual build step required.

## Security notes

- Binds to `127.0.0.1` by default — not exposed on the network unless the
  user explicitly passes `--addr 0.0.0.0`.
- Uses whatever access the local kubeconfig context already has; klogs
  itself performs no privilege escalation and only ever does read
  operations (`list`, `get`, `get log`) against the cluster — no `exec`,
  `delete`, `create`, etc.
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
