# klogs

A tiny, single-binary web app for browsing Kubernetes Deployments/Services
and tailing or downloading their pod logs — using your existing kubeconfig.

See [design.md](design.md) for the full spec.

## Run

```sh
go run ./cmd/klogs
```

Then open http://127.0.0.1:8080.

Flags:

```
--port int          port to serve the web UI on (default 8080)
--addr string        address to bind to (default "127.0.0.1")
--kubeconfig string  path to kubeconfig (default: $KUBECONFIG or ~/.kube/config)
```

## Build

```sh
go build -o klogs ./cmd/klogs
```

## Releases

Tagged pushes (`vX.Y.Z`) trigger a GitHub Actions release that builds
linux/darwin/windows amd64/arm64 binaries via GoReleaser and attaches them
to the GitHub Release. See `.github/workflows/release.yml` and
`.goreleaser.yaml`.
