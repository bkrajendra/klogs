// Package k8s wraps client-go for the subset of read-only operations klogs needs:
// listing contexts/namespaces/workloads/pods and fetching/streaming pod logs.
package k8s

import (
	"fmt"
	"sync"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

// Manager loads the kubeconfig once and hands out a cached clientset per
// context, so switching contexts in the UI doesn't require re-parsing the
// kubeconfig or re-establishing auth (exec plugins, OIDC, etc) each time.
type Manager struct {
	kubeconfigPath string
	rawConfig      clientcmd.ClientConfig

	mu         sync.Mutex
	clientsets map[string]kubernetes.Interface
}

// NewManager loads the kubeconfig from the given path, or from the standard
// locations ($KUBECONFIG, ~/.kube/config) if path is empty.
func NewManager(path string) (*Manager, error) {
	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	if path != "" {
		loadingRules.ExplicitPath = path
	}
	cfg := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loadingRules, &clientcmd.ConfigOverrides{})

	// Fail fast if the kubeconfig can't be found/parsed at all.
	if _, err := cfg.RawConfig(); err != nil {
		return nil, fmt.Errorf("loading kubeconfig: %w", err)
	}

	return &Manager{
		kubeconfigPath: path,
		rawConfig:      cfg,
		clientsets:     make(map[string]kubernetes.Interface),
	}, nil
}

// Context describes one entry from the kubeconfig's context list.
type Context struct {
	Name      string `json:"name"`
	Cluster   string `json:"cluster"`
	Namespace string `json:"namespace"`
	Current   bool   `json:"current"`
}

// Contexts lists all contexts defined in the kubeconfig, flagging the
// current (default) one.
func (m *Manager) Contexts() ([]Context, error) {
	raw, err := m.rawConfig.RawConfig()
	if err != nil {
		return nil, fmt.Errorf("reading kubeconfig: %w", err)
	}

	contexts := make([]Context, 0, len(raw.Contexts))
	for name, ctx := range raw.Contexts {
		contexts = append(contexts, Context{
			Name:      name,
			Cluster:   ctx.Cluster,
			Namespace: ctx.Namespace,
			Current:   name == raw.CurrentContext,
		})
	}
	return contexts, nil
}

// ClientsetFor returns a cached clientset for the given kubeconfig context
// name, building and caching a new one on first use.
func (m *Manager) ClientsetFor(contextName string) (kubernetes.Interface, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if cs, ok := m.clientsets[contextName]; ok {
		return cs, nil
	}

	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	if m.kubeconfigPath != "" {
		loadingRules.ExplicitPath = m.kubeconfigPath
	}
	overrides := &clientcmd.ConfigOverrides{}
	if contextName != "" {
		overrides.CurrentContext = contextName
	}

	restCfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loadingRules, overrides).ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("building client config for context %q: %w", contextName, err)
	}

	cs, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return nil, fmt.Errorf("building clientset for context %q: %w", contextName, err)
	}

	m.clientsets[contextName] = cs
	return cs, nil
}
