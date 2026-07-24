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
