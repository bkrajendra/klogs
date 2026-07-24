package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/bkrajendra/klogs/internal/k8s"
)

func (s *Server) registerAPI(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/contexts", s.handleContexts)
	mux.HandleFunc("GET /api/namespaces", s.handleNamespaces)
	mux.HandleFunc("GET /api/workloads", s.handleWorkloads)
	mux.HandleFunc("GET /api/workloads/{kind}/{name}/pods", s.handleWorkloadPods)
	mux.HandleFunc("POST /api/workloads/{kind}/{name}/restart", s.handleRestartWorkload)
	mux.HandleFunc("GET /api/pods", s.handlePods)
	mux.HandleFunc("GET /api/logs/download", s.handleLogDownload)
	mux.HandleFunc("GET /ws/logs", s.handleLogWS)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// Response is already partially written; nothing more we can do
		// but log it would go here if this handler had a logger.
		return
	}
}

func writeError(w http.ResponseWriter, status int, err error) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

func (s *Server) handleContexts(w http.ResponseWriter, r *http.Request) {
	ctxs, err := s.km.Contexts()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, ctxs)
}

func (s *Server) handleNamespaces(w http.ResponseWriter, r *http.Request) {
	contextName := r.URL.Query().Get("context")
	ns, err := s.km.Namespaces(r.Context(), contextName)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, ns)
}

func (s *Server) handleWorkloads(w http.ResponseWriter, r *http.Request) {
	contextName := r.URL.Query().Get("context")
	namespace := r.URL.Query().Get("namespace")
	if namespace == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("namespace is required"))
		return
	}

	wl, err := s.km.Workloads(r.Context(), contextName, namespace)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, wl)
}

func (s *Server) handleWorkloadPods(w http.ResponseWriter, r *http.Request) {
	contextName := r.URL.Query().Get("context")
	namespace := r.URL.Query().Get("namespace")
	kind := r.PathValue("kind")
	name := r.PathValue("name")
	if namespace == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("namespace is required"))
		return
	}

	pods, err := s.km.WorkloadPods(r.Context(), contextName, namespace, kind, name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, pods)
}

func (s *Server) handlePods(w http.ResponseWriter, r *http.Request) {
	contextName := r.URL.Query().Get("context")
	namespace := r.URL.Query().Get("namespace")
	if namespace == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("namespace is required"))
		return
	}

	pods, err := s.km.Pods(r.Context(), contextName, namespace)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, pods)
}

func (s *Server) handleRestartWorkload(w http.ResponseWriter, r *http.Request) {
	contextName := r.URL.Query().Get("context")
	namespace := r.URL.Query().Get("namespace")
	kind := r.PathValue("kind")
	name := r.PathValue("name")
	if namespace == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("namespace is required"))
		return
	}

	if err := s.km.RestartWorkload(r.Context(), contextName, namespace, kind, name); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, map[string]string{"status": "restarted"})
}

// logOptionsFromQuery parses the query params shared by the download and
// WebSocket log endpoints.
func logOptionsFromQuery(r *http.Request) (contextName, namespace, pod string, opts k8s.LogOptions, err error) {
	q := r.URL.Query()
	contextName = q.Get("context")
	namespace = q.Get("namespace")
	pod = q.Get("pod")
	if namespace == "" || pod == "" {
		err = fmt.Errorf("namespace and pod are required")
		return
	}

	opts.Container = q.Get("container")
	opts.Previous = q.Get("previous") == "true"
	opts.Follow = q.Get("follow") == "true"

	if tail := q.Get("tailLines"); tail != "" {
		n, perr := strconv.ParseInt(tail, 10, 64)
		if perr != nil {
			err = fmt.Errorf("invalid tailLines: %w", perr)
			return
		}
		opts.TailLines = &n
	}
	return
}

// handleLogDownload streams a pod's log as a file attachment. It never
// follows, regardless of the follow query param, since a download should
// terminate once the currently available log is sent.
func (s *Server) handleLogDownload(w http.ResponseWriter, r *http.Request) {
	contextName, namespace, pod, opts, err := logOptionsFromQuery(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	opts.Follow = false

	stream, err := s.km.StreamLogs(r.Context(), contextName, namespace, pod, opts)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	defer stream.Close()

	filename := pod
	if opts.Container != "" {
		filename = fmt.Sprintf("%s_%s", pod, opts.Container)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.log"`, filename))
	w.WriteHeader(http.StatusOK)

	if _, err := io.Copy(w, stream); err != nil {
		s.log.Warn("log download interrupted", "pod", pod, "error", err)
	}
}
