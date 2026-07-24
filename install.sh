#!/usr/bin/env bash
# Installs the klogs binary for the current OS/arch from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/bkrajendra/klogs/main/install.sh | bash
#
# Env vars:
#   KLOGS_VERSION      version tag to install, e.g. v0.1.1 (default: latest release)
#   KLOGS_INSTALL_DIR  directory to install into (default: /usr/local/bin if
#                      writable, else ~/.local/bin)
set -euo pipefail

REPO="bkrajendra/klogs"
BINARY="klogs"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: required command '$1' not found" >&2
    exit 1
  }
}
need curl

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Linux) goos="linux" ;;
  Darwin) goos="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) goos="windows" ;;
  *)
    echo "error: unsupported OS '$os'" >&2
    exit 1
    ;;
esac

case "$arch" in
  x86_64|amd64) goarch="amd64" ;;
  arm64|aarch64) goarch="arm64" ;;
  *)
    echo "error: unsupported architecture '$arch'" >&2
    exit 1
    ;;
esac

version="${KLOGS_VERSION:-}"
if [ -z "$version" ]; then
  echo "Resolving latest klogs release..."
  version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
fi
if [ -z "$version" ]; then
  echo "error: could not determine the latest klogs version (set KLOGS_VERSION to pin one)" >&2
  exit 1
fi

ext="tar.gz"
if [ "$goos" = "windows" ]; then
  ext="zip"
  need unzip
else
  need tar
fi

archive="${BINARY}_${goos}_${goarch}.${ext}"
base_url="https://github.com/$REPO/releases/download/$version"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading klogs $version for $goos/$goarch..."
curl -fsSL -o "$tmp/$archive" "$base_url/$archive"
curl -fsSL -o "$tmp/checksums.txt" "$base_url/checksums.txt"

echo "Verifying checksum..."
expected=$(grep " $archive\$" "$tmp/checksums.txt" | awk '{print $1}')
if [ -z "$expected" ]; then
  echo "error: no checksum entry for $archive in checksums.txt" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$archive" | awk '{print $1}')
else
  need shasum
  actual=$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')
fi
if [ "$expected" != "$actual" ]; then
  echo "error: checksum mismatch for $archive" >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi
echo "Checksum OK."

bin_name="$BINARY"
if [ "$goos" = "windows" ]; then
  bin_name="${BINARY}.exe"
  unzip -q "$tmp/$archive" -d "$tmp"
else
  tar -xzf "$tmp/$archive" -C "$tmp"
fi

install_dir="${KLOGS_INSTALL_DIR:-}"
if [ -z "$install_dir" ]; then
  if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
    install_dir="/usr/local/bin"
  else
    install_dir="$HOME/.local/bin"
  fi
fi
mkdir -p "$install_dir"
mv "$tmp/$bin_name" "$install_dir/$bin_name"
chmod +x "$install_dir/$bin_name"

echo "Installed to $install_dir/$bin_name"

case ":${PATH}:" in
  *":$install_dir:"*) ;;
  *)
    echo
    echo "NOTE: $install_dir is not on your PATH."
    echo "Add this to your shell profile (e.g. ~/.bashrc, ~/.zshrc):"
    echo "  export PATH=\"$install_dir:\$PATH\""
    ;;
esac

echo
echo "Run '$BINARY --version' to verify, then '$BINARY --open' to launch the web UI."
