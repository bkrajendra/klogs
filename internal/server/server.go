// Package server wires up the HTTP API, WebSocket log streaming, and the
// embedded static frontend into a single http.Handler.
package server

import (
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/bkrajendra/klogs/internal/k8s"
	"github.com/bkrajendra/klogs/internal/update"
	"github.com/bkrajendra/klogs/web"
)

// Server holds the dependencies shared by the HTTP handlers.
type Server struct {
	km         *k8s.Manager
	log        *slog.Logger
	version    string
	updateMgr  *update.Manager
	httpServer *http.Server // set via SetHTTPServer once main constructs it

	mux *http.ServeMux
}

// New builds the full HTTP handler for klogs: the REST/WebSocket API under
// /api and /ws, and the embedded static frontend for everything else.
func New(km *k8s.Manager, log *slog.Logger, version string, updateMgr *update.Manager) (*Server, error) {
	s := &Server{km: km, log: log, version: version, updateMgr: updateMgr}

	static, err := fs.Sub(web.Static, "static")
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	s.registerAPI(mux)
	mux.Handle("/", http.FileServer(http.FS(static)))
	s.mux = mux

	return s, nil
}

// Handler returns the http.Handler to serve. Split out from New so the
// caller can build an *http.Server wrapping it and hand that back via
// SetHTTPServer before serving - the /api/update/restart handler needs
// that reference to shut the server down cleanly before re-exec'ing.
func (s *Server) Handler() http.Handler {
	return s.mux
}

// SetHTTPServer records the *http.Server this handler is being served
// through, so the update-restart handler can shut it down before spawning
// the newly-installed binary.
func (s *Server) SetHTTPServer(httpServer *http.Server) {
	s.httpServer = httpServer
}
