// Package update implements klogs's self-update mechanism: given a release
// version tag, it downloads the matching release archive for the current
// OS/arch from GitHub, verifies it against the release's checksums.txt, and
// replaces the currently running executable with it. Restarting into the
// new binary is a separate, explicit step (see Restart).
package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// Stage is one step of an in-progress update.
type Stage string

const (
	StageIdle        Stage = "idle"
	StageDownloading Stage = "downloading"
	StageVerifying   Stage = "verifying"
	StageInstalling  Stage = "installing"
	StageDone        Stage = "done"
	StageError       Stage = "error"
)

// Status is a snapshot of the update manager's current state, safe to
// serialize directly as the /api/update/status response.
type Status struct {
	Stage   Stage  `json:"stage"`
	Version string `json:"version,omitempty"`
	Message string `json:"message,omitempty"`
}

// Manager tracks the state of an in-progress (or most recent) update.
type Manager struct {
	repo    string // "owner/name" on GitHub
	baseURL string // overridable in tests; defaults to https://github.com
	// exePathOverride replaces the os.Executable() lookup in tests, so
	// they exercise the install logic against a throwaway file instead
	// of the running test binary itself.
	exePathOverride string

	mu      sync.Mutex
	status  Status
	running bool
	// resolvedExePath is cached on first resolution and reused after
	// that. os.Executable() becomes unreliable once we've done a
	// rename-based update: on Linux, /proc/self/exe tracks the *current*
	// name of the running process's backing file, so after we rename it
	// aside to ".old" and then remove that backup, a fresh
	// os.Executable() call resolves to a path that no longer exists.
	resolvedExePath string
}

// NewManager builds a Manager for the given "owner/repo" GitHub repository.
func NewManager(repo string) *Manager {
	return &Manager{
		repo:    repo,
		baseURL: "https://github.com",
		status:  Status{Stage: StageIdle},
	}
}

// SetBaseURL overrides the GitHub host releases are downloaded from
// (defaults to https://github.com). Mainly for testing against a local
// fake release server.
func (m *Manager) SetBaseURL(baseURL string) {
	m.baseURL = baseURL
}

// Status returns the current status snapshot.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *Manager) setStatus(s Status) {
	m.mu.Lock()
	m.status = s
	m.mu.Unlock()
}

// Start begins downloading and installing the given release version (e.g.
// "v0.2.0") in the background. Returns false without doing anything if an
// update is already running.
func (m *Manager) Start(version string) bool {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return false
	}
	m.running = true
	m.mu.Unlock()

	go func() {
		defer func() {
			m.mu.Lock()
			m.running = false
			m.mu.Unlock()
		}()
		if err := m.apply(version); err != nil {
			m.setStatus(Status{Stage: StageError, Version: version, Message: err.Error()})
		}
	}()
	return true
}

// currentExecutable resolves the path to the running executable, caching
// the result so it's only ever computed once per process (see the
// resolvedExePath field doc for why a fresh lookup can't be trusted after
// this package has already done one rename-based update).
func (m *Manager) currentExecutable() (string, error) {
	m.mu.Lock()
	if m.resolvedExePath != "" {
		p := m.resolvedExePath
		m.mu.Unlock()
		return p, nil
	}
	m.mu.Unlock()

	exePath := m.exePathOverride
	if exePath == "" {
		var err error
		exePath, err = os.Executable()
		if err != nil {
			return "", fmt.Errorf("locating current executable: %w", err)
		}
		exePath, err = filepath.EvalSymlinks(exePath)
		if err != nil {
			return "", fmt.Errorf("resolving executable path: %w", err)
		}
	}

	m.mu.Lock()
	m.resolvedExePath = exePath
	m.mu.Unlock()
	return exePath, nil
}

func (m *Manager) apply(version string) error {
	exePath, err := m.currentExecutable()
	if err != nil {
		return err
	}

	goos, goarch := runtime.GOOS, runtime.GOARCH
	ext := "tar.gz"
	binName := "klogs"
	if goos == "windows" {
		ext = "zip"
		binName = "klogs.exe"
	}
	archiveName := fmt.Sprintf("klogs_%s_%s.%s", goos, goarch, ext)
	releaseURL := fmt.Sprintf("%s/%s/releases/download/%s", m.baseURL, m.repo, version)

	tmpDir, err := os.MkdirTemp("", "klogs-update-*")
	if err != nil {
		return fmt.Errorf("creating temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	m.setStatus(Status{Stage: StageDownloading, Version: version, Message: "downloading " + archiveName})
	archivePath := filepath.Join(tmpDir, archiveName)
	if err := downloadFile(releaseURL+"/"+archiveName, archivePath); err != nil {
		return fmt.Errorf("downloading %s: %w", archiveName, err)
	}
	checksumsPath := filepath.Join(tmpDir, "checksums.txt")
	if err := downloadFile(releaseURL+"/checksums.txt", checksumsPath); err != nil {
		return fmt.Errorf("downloading checksums.txt: %w", err)
	}

	m.setStatus(Status{Stage: StageVerifying, Version: version, Message: "verifying checksum"})
	if err := verifyChecksum(archivePath, archiveName, checksumsPath); err != nil {
		return err
	}

	m.setStatus(Status{Stage: StageInstalling, Version: version, Message: "installing"})

	// Extract into the same directory as the running executable so the
	// final rename-into-place below is a same-filesystem, near-atomic
	// operation rather than a cross-device copy.
	destDir := filepath.Dir(exePath)
	newBinPath := filepath.Join(destDir, ".klogs-update-new")
	if goos == "windows" {
		newBinPath += ".exe"
	}
	var extractErr error
	if goos == "windows" {
		extractErr = extractZipBinary(archivePath, binName, newBinPath)
	} else {
		extractErr = extractTarGzBinary(archivePath, binName, newBinPath)
	}
	if extractErr != nil {
		return fmt.Errorf("extracting %s: %w", binName, extractErr)
	}
	defer os.Remove(newBinPath) // no-op once it's been renamed into place below

	if err := os.Chmod(newBinPath, 0o755); err != nil {
		return fmt.Errorf("chmod new binary: %w", err)
	}

	if err := replaceExecutable(exePath, newBinPath); err != nil {
		return err
	}

	m.setStatus(Status{Stage: StageDone, Version: version, Message: "restart to use " + version})
	return nil
}

// replaceExecutable swaps newPath into exePath's place. It renames the
// running executable aside first rather than overwriting it directly,
// since Windows won't allow deleting or overwriting a running .exe's data
// (though renaming it is fine) - the same pattern works unchanged on
// Unix, where it's simply an atomic directory-entry swap.
func replaceExecutable(exePath, newPath string) error {
	backupPath := exePath + ".old"
	os.Remove(backupPath) // best-effort cleanup from a previous update

	if err := os.Rename(exePath, backupPath); err != nil {
		return fmt.Errorf("renaming current binary aside: %w", err)
	}
	if err := os.Rename(newPath, exePath); err != nil {
		if rbErr := os.Rename(backupPath, exePath); rbErr != nil {
			return fmt.Errorf("installing new binary: %w (rollback also failed: %v)", err, rbErr)
		}
		return fmt.Errorf("installing new binary: %w", err)
	}
	os.Remove(backupPath)
	return nil
}

func downloadFile(url, dest string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d for %s", resp.StatusCode, url)
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = io.Copy(f, resp.Body)
	return err
}

func verifyChecksum(archivePath, archiveName, checksumsPath string) error {
	data, err := os.ReadFile(checksumsPath)
	if err != nil {
		return err
	}

	var expected string
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == archiveName {
			expected = fields[0]
			break
		}
	}
	if expected == "" {
		return fmt.Errorf("no checksum entry for %s in checksums.txt", archiveName)
	}

	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	actual := hex.EncodeToString(h.Sum(nil))
	if actual != expected {
		return fmt.Errorf("checksum mismatch for %s: expected %s, got %s", archiveName, expected, actual)
	}
	return nil
}

func extractTarGzBinary(archivePath, binName, dest string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("%q not found in archive", binName)
		}
		if err != nil {
			return err
		}
		if hdr.Name != binName {
			continue
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		defer out.Close()
		_, err = io.Copy(out, tr)
		return err
	}
}

func extractZipBinary(archivePath, binName, dest string) error {
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer zr.Close()

	for _, zf := range zr.File {
		if zf.Name != binName {
			continue
		}
		rc, err := zf.Open()
		if err != nil {
			return err
		}
		defer rc.Close()

		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		defer out.Close()
		_, err = io.Copy(out, rc)
		return err
	}
	return fmt.Errorf("%q not found in archive", binName)
}
