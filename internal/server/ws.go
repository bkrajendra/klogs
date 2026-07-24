package server

import (
	"bufio"
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	// klogs is a localhost dev tool with no cookie-based auth to protect,
	// so cross-origin WS upgrades are allowed same as the REST API.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// handleLogWS streams a pod's log to the browser over a WebSocket, one
// text message per line. The underlying k8s log stream is torn down when
// the client disconnects, since it's opened with the request context.
func (s *Server) handleLogWS(w http.ResponseWriter, r *http.Request) {
	contextName, namespace, pod, opts, err := logOptionsFromQuery(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.log.Warn("ws upgrade failed", "error", err)
		return
	}
	defer conn.Close()

	ctx := r.Context()
	stream, err := s.km.StreamLogs(ctx, contextName, namespace, pod, opts)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte("error: "+err.Error()))
		return
	}
	defer stream.Close()

	// Detect client-initiated close (e.g. tab closed) so we stop reading
	// from the k8s stream promptly instead of only noticing on next write.
	go func() {
		for {
			if _, _, err := conn.NextReader(); err != nil {
				stream.Close()
				return
			}
		}
	}()

	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		if err := conn.WriteMessage(websocket.TextMessage, scanner.Bytes()); err != nil {
			return
		}
	}
}
