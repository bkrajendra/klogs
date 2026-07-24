package k8s

import (
	"os"
	"path/filepath"
	"testing"
)

const testKubeconfig = `apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://example.invalid:6443
  name: test-cluster
contexts:
- context:
    cluster: test-cluster
    namespace: default
  name: test-context
current-context: test-context
users: []
`

func writeTestKubeconfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte(testKubeconfig), 0o600); err != nil {
		t.Fatalf("writing test kubeconfig: %v", err)
	}
	return path
}

func TestContexts(t *testing.T) {
	m, err := NewManager(writeTestKubeconfig(t))
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	contexts, err := m.Contexts()
	if err != nil {
		t.Fatalf("Contexts: %v", err)
	}
	if len(contexts) != 1 {
		t.Fatalf("expected 1 context, got %d", len(contexts))
	}
	if contexts[0].Name != "test-context" || !contexts[0].Current {
		t.Errorf("unexpected context: %+v", contexts[0])
	}
}

func TestClientsetFor(t *testing.T) {
	m, err := NewManager(writeTestKubeconfig(t))
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	cs1, err := m.ClientsetFor("test-context")
	if err != nil {
		t.Fatalf("ClientsetFor: %v", err)
	}
	cs2, err := m.ClientsetFor("test-context")
	if err != nil {
		t.Fatalf("ClientsetFor (cached): %v", err)
	}
	if cs1 != cs2 {
		t.Error("expected cached clientset to be reused")
	}
}
