// Command klogs serves a small web UI for browsing Kubernetes
// Deployments/Services and tailing/downloading their pod logs, using the
// caller's existing kubeconfig.
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"

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

	handler, err := server.New(km, log)
	if err != nil {
		log.Error("failed to build server", "error", err)
		os.Exit(1)
	}

	listenAddr := fmt.Sprintf("%s:%d", *addr, *port)
	fmt.Printf("klogs serving on http://%s\n", listenAddr)

	if err := http.ListenAndServe(listenAddr, handler); err != nil {
		log.Error("server error", "error", err)
		os.Exit(1)
	}
}
