package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// buildFakeRelease constructs the archive + checksums.txt bytes a real
// GoReleaser release would produce for the current OS/arch, containing a
// single fake binary file with the given content.
func buildFakeRelease(t *testing.T, binName string, content []byte) (archiveName string, archiveBytes []byte, checksums string) {
	t.Helper()

	if runtime.GOOS == "windows" {
		archiveName = fmt.Sprintf("klogs_%s_%s.zip", runtime.GOOS, runtime.GOARCH)
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		w, err := zw.Create(binName)
		if err != nil {
			t.Fatalf("zip create: %v", err)
		}
		if _, err := w.Write(content); err != nil {
			t.Fatalf("zip write: %v", err)
		}
		if err := zw.Close(); err != nil {
			t.Fatalf("zip close: %v", err)
		}
		archiveBytes = buf.Bytes()
	} else {
		archiveName = fmt.Sprintf("klogs_%s_%s.tar.gz", runtime.GOOS, runtime.GOARCH)
		var buf bytes.Buffer
		gw := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gw)
		hdr := &tar.Header{Name: binName, Mode: 0o755, Size: int64(len(content))}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("tar header: %v", err)
		}
		if _, err := tw.Write(content); err != nil {
			t.Fatalf("tar write: %v", err)
		}
		if err := tw.Close(); err != nil {
			t.Fatalf("tar close: %v", err)
		}
		if err := gw.Close(); err != nil {
			t.Fatalf("gzip close: %v", err)
		}
		archiveBytes = buf.Bytes()
	}

	sum := sha256.Sum256(archiveBytes)
	checksums = fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), archiveName)
	return archiveName, archiveBytes, checksums
}

func waitForTerminal(t *testing.T, m *Manager) Status {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s := m.Status()
		if s.Stage == StageDone || s.Stage == StageError {
			return s
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("update did not reach a terminal state in time")
	return Status{}
}

func TestApplySuccess(t *testing.T) {
	binName := "klogs"
	if runtime.GOOS == "windows" {
		binName = "klogs.exe"
	}
	newContent := []byte("#!/bin/sh\necho fake-new-binary-v2\n")
	archiveName, archiveBytes, checksums := buildFakeRelease(t, binName, newContent)

	mux := http.NewServeMux()
	mux.HandleFunc("/testrepo/releases/download/v2.0.0/"+archiveName, func(w http.ResponseWriter, r *http.Request) {
		w.Write(archiveBytes)
	})
	mux.HandleFunc("/testrepo/releases/download/v2.0.0/checksums.txt", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(checksums))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	dir := t.TempDir()
	exePath := filepath.Join(dir, binName)
	if err := os.WriteFile(exePath, []byte("old-binary-content"), 0o755); err != nil {
		t.Fatalf("writing fake exe: %v", err)
	}

	m := &Manager{repo: "testrepo", baseURL: srv.URL, exePathOverride: exePath, status: Status{Stage: StageIdle}}
	if !m.Start("v2.0.0") {
		t.Fatal("Start returned false unexpectedly")
	}
	final := waitForTerminal(t, m)
	if final.Stage != StageDone {
		t.Fatalf("expected StageDone, got %+v", final)
	}

	got, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatalf("reading updated exe: %v", err)
	}
	if !bytes.Equal(got, newContent) {
		t.Fatalf("executable content = %q, want %q", got, newContent)
	}

	if _, err := os.Stat(exePath + ".old"); !os.IsNotExist(err) {
		t.Fatalf(".old backup should have been cleaned up, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".klogs-update-new")); !os.IsNotExist(err) {
		t.Fatalf("temp new-binary file should have been renamed away, stat err = %v", err)
	}
}

func TestApplyChecksumMismatchLeavesOriginalIntact(t *testing.T) {
	binName := "klogs"
	if runtime.GOOS == "windows" {
		binName = "klogs.exe"
	}
	archiveName, archiveBytes, _ := buildFakeRelease(t, binName, []byte("whatever"))

	mux := http.NewServeMux()
	mux.HandleFunc("/testrepo/releases/download/v3.0.0/"+archiveName, func(w http.ResponseWriter, r *http.Request) {
		w.Write(archiveBytes)
	})
	mux.HandleFunc("/testrepo/releases/download/v3.0.0/checksums.txt", func(w http.ResponseWriter, r *http.Request) {
		// Deliberately wrong checksum.
		fmt.Fprintf(w, "0000000000000000000000000000000000000000000000000000000000000000  %s\n", archiveName)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	dir := t.TempDir()
	exePath := filepath.Join(dir, binName)
	original := []byte("original-binary-content")
	if err := os.WriteFile(exePath, original, 0o755); err != nil {
		t.Fatalf("writing fake exe: %v", err)
	}

	m := &Manager{repo: "testrepo", baseURL: srv.URL, exePathOverride: exePath, status: Status{Stage: StageIdle}}
	if !m.Start("v3.0.0") {
		t.Fatal("Start returned false unexpectedly")
	}
	final := waitForTerminal(t, m)
	if final.Stage != StageError {
		t.Fatalf("expected StageError, got %+v", final)
	}

	got, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatalf("reading exe after failed update: %v", err)
	}
	if !bytes.Equal(got, original) {
		t.Fatalf("original executable was modified despite checksum failure: got %q", got)
	}
	if _, err := os.Stat(exePath + ".old"); !os.IsNotExist(err) {
		t.Fatalf("no .old backup should remain after a failed (pre-replace) update, stat err = %v", err)
	}
}

func TestStartRejectsConcurrentUpdate(t *testing.T) {
	// Deliberately unreachable address so the first update stays in the
	// "downloading" stage long enough to observe the second Start being
	// rejected while it's running.
	m := &Manager{repo: "testrepo", baseURL: "http://127.0.0.1:1", status: Status{Stage: StageIdle}}
	if !m.Start("v1.0.0") {
		t.Fatal("first Start should succeed")
	}
	if m.Start("v1.0.0") {
		t.Fatal("second concurrent Start should be rejected")
	}
}
