// Package server wires up the HTTP API, WebSocket log streaming, and the
// embedded static frontend into a single http.Handler.
package server

import (
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/bkrajendra/klogs/internal/k8s"
	"github.com/bkrajendra/klogs/web"
)

// Server holds the dependencies shared by the HTTP handlers.
type Server struct {
	km  *k8s.Manager
	log *slog.Logger
}

// New builds the full HTTP handler for klogs: the REST/WebSocket API under
// /api and /ws, and the embedded static frontend for everything else.
func New(km *k8s.Manager, log *slog.Logger) (http.Handler, error) {
	s := &Server{km: km, log: log}

	static, err := fs.Sub(web.Static, "static")
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	s.registerAPI(mux)
	mux.Handle("/", http.FileServer(http.FS(static)))

	return mux, nil
}
