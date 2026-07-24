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

	"github.com/bkrajendra/klogs/internal/k8s"
	"github.com/bkrajendra/klogs/internal/server"
)

// version is set at build time via -ldflags by GoReleaser.
var version = "dev"

func main() {
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

	handler, err := server.New(km, log, version)
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

	if err := http.Serve(ln, handler); err != nil {
		log.Error("server error", "error", err)
		os.Exit(1)
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
