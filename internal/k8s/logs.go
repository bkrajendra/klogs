package k8s

import (
	"context"
	"fmt"
	"io"

	corev1 "k8s.io/api/core/v1"
)

// LogOptions controls how a pod's log is fetched.
type LogOptions struct {
	Container string
	Follow    bool
	Previous  bool
	TailLines *int64 // nil means "all available lines"
}

// StreamLogs opens the pod's log stream and returns a ReadCloser. The
// caller is responsible for closing it; canceling ctx also stops the
// stream, which is how the WebSocket handler tears down a follow on
// client disconnect.
func (m *Manager) StreamLogs(ctx context.Context, contextName, namespace, pod string, opts LogOptions) (io.ReadCloser, error) {
	cs, err := m.ClientsetFor(contextName)
	if err != nil {
		return nil, err
	}

	podLogOpts := &corev1.PodLogOptions{
		Container: opts.Container,
		Follow:    opts.Follow,
		Previous:  opts.Previous,
		TailLines: opts.TailLines,
	}

	req := cs.CoreV1().Pods(namespace).GetLogs(pod, podLogOpts)
	stream, err := req.Stream(ctx)
	if err != nil {
		return nil, fmt.Errorf("opening log stream for pod %q: %w", pod, err)
	}
	return stream, nil
}
