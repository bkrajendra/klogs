package update

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"time"
)

// Restart spawns a new process running the (just-updated) executable with
// the same arguments, then shuts down srv to free the port before exiting
// this process. srv.Shutdown releases the listener without waiting on
// hijacked connections (e.g. open log-stream WebSockets), so this doesn't
// block on those; they simply end when this process exits moments later.
//
// It's a method rather than relying on a fresh os.Executable() call so it
// reuses the exe path cached by currentExecutable() during apply() -
// resolving it again here would hit the same staleness problem that
// caching was added to avoid.
//
// The caller is responsible for having already written its HTTP response
// before calling this, since Shutdown will otherwise deadlock waiting for
// the very request handler that's calling it.
func (m *Manager) Restart(srv *http.Server) error {
	exePath, err := m.currentExecutable()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx) // best-effort; releases the listener either way once it returns

	cmd := exec.Command(exePath, os.Args[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Start(); err != nil {
		// The listener is already closed (Shutdown ran above), so this
		// process can no longer serve anything either way - exit rather
		// than leave it sitting in the caller's post-Serve() select{}
		// forever with nothing listening and no replacement spawned.
		go func() {
			time.Sleep(50 * time.Millisecond)
			os.Exit(1)
		}()
		return fmt.Errorf("starting new process: %w", err)
	}

	go func() {
		time.Sleep(150 * time.Millisecond)
		os.Exit(0)
	}()
	return nil
}
