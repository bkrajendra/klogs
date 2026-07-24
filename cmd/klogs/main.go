// Command klogs serves a small web UI for browsing Kubernetes
// Deployments/Services and tailing/downloading their pod logs, using the
// caller's existing kubeconfig.
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/bkrajendra/klogs/internal/k8s"
	"github.com/bkrajendra/klogs/internal/server"
	"github.com/bkrajendra/klogs/internal/update"
)

// version is set at build time via -ldflags by GoReleaser.
var version = "dev"

const githubRepo = "bkrajendra/klogs"

func main() {
	// "klogs update" is a plain CLI subcommand rather than a flag, since
	// it's a one-shot action distinct from starting the server: download,
	// verify, swap the binary, then tell the user to restart. No live
	// HTTP server to shut down and no self-respawn here, unlike the web
	// UI's update flow - just the simple, safe version of this that works
	// the same way on every platform.
	if len(os.Args) > 1 && os.Args[1] == "update" {
		runUpdateCommand(os.Args[2:])
		return
	}

	var (
		port        = flag.Int("port", 8080, "port to serve the web UI on")
		addr        = flag.String("addr", "127.0.0.1", "address to bind to")
		kubeconfig  = flag.String("kubeconfig", "", "path to kubeconfig (default: $KUBECONFIG or ~/.kube/config)")
		openBrowser = flag.Bool("open", false, "open the web UI in the default browser once the server starts")
		showVersion = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *showVersion {
		fmt.Println("klogs", version)
		return
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	km, err := k8s.NewManager(*kubeconfig)
	if err != nil {
		log.Error("failed to load kubeconfig", "error", err)
		os.Exit(1)
	}

	updateMgr := update.NewManager(githubRepo)
	if base := os.Getenv("KLOGS_UPDATE_BASE_URL"); base != "" {
		updateMgr.SetBaseURL(base)
	}

	srv, err := server.New(km, log, version, updateMgr)
	if err != nil {
		log.Error("failed to build server", "error", err)
		os.Exit(1)
	}

	listenAddr := fmt.Sprintf("%s:%d", *addr, *port)
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		log.Error("failed to listen", "addr", listenAddr, "error", err)
		os.Exit(1)
	}

	url := fmt.Sprintf("http://%s", browserAddr(*addr, *port))
	fmt.Printf("klogs serving on %s\n", url)

	if *openBrowser {
		if err := openInBrowser(url); err != nil {
			log.Warn("failed to open browser", "error", err)
		}
	}

	httpServer := &http.Server{Handler: srv.Handler()}
	srv.SetHTTPServer(httpServer)

	// A self-update restart shuts httpServer down and spawns the new
	// binary; Serve then returns http.ErrServerClosed, which is the
	// expected/successful exit path here, not an error.
	if err := httpServer.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Error("server error", "error", err)
		os.Exit(1)
	}

	// Shutdown() (called by update.Manager.Restart, from a separate
	// goroutine) closes the listener as its very first action, which is
	// what just unblocked Serve() above - almost always before that
	// other goroutine has gone on to actually spawn the replacement
	// process. If main() returned here, that return would race - and
	// effectively always win, since finishing Serve()'s unwind takes way
	// less work than resuming the other goroutine - killing the whole
	// process before the restart can complete. So instead: block forever
	// and let Restart()'s own explicit os.Exit be what actually ends
	// this process, once it's done (successfully or not).
	select {}
}

// runUpdateCommand implements `klogs update [--version vX.Y.Z]`: resolve
// the target version (latest, unless pinned), download and install it via
// the same internal/update logic the web UI uses, print progress, and
// exit - the caller restarts klogs themselves when they're ready.
func runUpdateCommand(args []string) {
	fs := flag.NewFlagSet("update", flag.ExitOnError)
	targetVersion := fs.String("version", "", "release version to install, e.g. v0.2.0 (default: latest)")
	fs.Parse(args)

	updateMgr := update.NewManager(githubRepo)
	if base := os.Getenv("KLOGS_UPDATE_BASE_URL"); base != "" {
		updateMgr.SetBaseURL(base)
	}

	v := *targetVersion
	if v == "" {
		fmt.Println("Checking for the latest klogs release...")
		var err error
		v, err = update.LatestVersion(githubRepo)
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	}

	fmt.Printf("Updating klogs to %s...\n", v)
	updateMgr.Start(v)

	var lastStage update.Stage
	for {
		time.Sleep(200 * time.Millisecond)
		st := updateMgr.Status()

		if st.Stage != lastStage {
			lastStage = st.Stage
			switch st.Stage {
			case update.StageDone:
				fmt.Printf("Installed %s. Restart klogs to use it.\n", st.Version)
				return
			case update.StageError:
				fmt.Fprintln(os.Stderr, "error:", st.Message)
				os.Exit(1)
			default:
				fmt.Printf("  %s\n", st.Message)
			}
		}
	}
}

// browserAddr substitutes a loopback-reachable host when the server is
// bound to a wildcard address, since "http://0.0.0.0:8080" doesn't open in
// a browser on most platforms.
func browserAddr(addr string, port int) string {
	if addr == "0.0.0.0" || addr == "::" || addr == "" {
		addr = "127.0.0.1"
	}
	return fmt.Sprintf("%s:%d", addr, port)
}

func openInBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}
