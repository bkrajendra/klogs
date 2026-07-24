package k8s

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/kubernetes"
)

// Namespace is a minimal projection of corev1.Namespace for the UI's
// namespace picker.
type Namespace struct {
	Name string `json:"name"`
}

// Namespaces lists all namespaces visible in the given context.
func (m *Manager) Namespaces(ctx context.Context, contextName string) ([]Namespace, error) {
	cs, err := m.ClientsetFor(contextName)
	if err != nil {
		return nil, err
	}

	list, err := cs.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("listing namespaces: %w", err)
	}

	out := make([]Namespace, 0, len(list.Items))
	for _, ns := range list.Items {
		out = append(out, Namespace{Name: ns.Name})
	}
	return out, nil
}

// Workload is a Deployment or Service, summarized for the workload list view.
type Workload struct {
	Kind      string `json:"kind"` // "deployment" or "service"
	Name      string `json:"name"`
	Ready     int32  `json:"ready"`
	Desired   int32  `json:"desired"`
	Namespace string `json:"namespace"`
}

// Workloads lists Deployments and Services in the given namespace.
func (m *Manager) Workloads(ctx context.Context, contextName, namespace string) ([]Workload, error) {
	cs, err := m.ClientsetFor(contextName)
	if err != nil {
		return nil, err
	}

	deployments, err := cs.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("listing deployments: %w", err)
	}
	services, err := cs.CoreV1().Services(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("listing services: %w", err)
	}

	out := make([]Workload, 0, len(deployments.Items)+len(services.Items))
	for _, d := range deployments.Items {
		out = append(out, Workload{
			Kind:      "deployment",
			Name:      d.Name,
			Namespace: d.Namespace,
			Ready:     d.Status.ReadyReplicas,
			Desired:   d.Status.Replicas,
		})
	}
	for _, s := range services.Items {
		out = append(out, Workload{
			Kind:      "service",
			Name:      s.Name,
			Namespace: s.Namespace,
		})
	}
	return out, nil
}

// Pod is a minimal projection of corev1.Pod for the pod/container picker.
type Pod struct {
	Name       string   `json:"name"`
	Phase      string   `json:"phase"`
	Containers []string `json:"containers"`
}

func toPod(p corev1.Pod) Pod {
	containers := make([]string, 0, len(p.Spec.Containers))
	for _, c := range p.Spec.Containers {
		containers = append(containers, c.Name)
	}
	return Pod{
		Name:       p.Name,
		Phase:      string(p.Status.Phase),
		Containers: containers,
	}
}

// Pods lists all pods in the namespace, unfiltered.
func (m *Manager) Pods(ctx context.Context, contextName, namespace string) ([]Pod, error) {
	cs, err := m.ClientsetFor(contextName)
	if err != nil {
		return nil, err
	}

	list, err := cs.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("listing pods: %w", err)
	}

	out := make([]Pod, 0, len(list.Items))
	for _, p := range list.Items {
		out = append(out, toPod(p))
	}
	return out, nil
}

// WorkloadPods resolves the pods backing a Deployment or Service by kind+name.
func (m *Manager) WorkloadPods(ctx context.Context, contextName, namespace, kind, name string) ([]Pod, error) {
	cs, err := m.ClientsetFor(contextName)
	if err != nil {
		return nil, err
	}

	var selector labels.Selector
	switch kind {
	case "deployment":
		d, err := cs.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, fmt.Errorf("getting deployment %q: %w", name, err)
		}
		selector, err = metav1.LabelSelectorAsSelector(d.Spec.Selector)
		if err != nil {
			return nil, fmt.Errorf("parsing deployment selector: %w", err)
		}
	case "service":
		s, err := cs.CoreV1().Services(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, fmt.Errorf("getting service %q: %w", name, err)
		}
		if len(s.Spec.Selector) == 0 {
			return podsFromEndpoints(ctx, cs, namespace, name)
		}
		selector = labels.SelectorFromSet(s.Spec.Selector)
	default:
		return nil, fmt.Errorf("unknown workload kind %q", kind)
	}

	list, err := cs.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector.String()})
	if err != nil {
		return nil, fmt.Errorf("listing pods for %s %q: %w", kind, name, err)
	}

	out := make([]Pod, 0, len(list.Items))
	for _, p := range list.Items {
		out = append(out, toPod(p))
	}
	return out, nil
}

// podsFromEndpoints resolves pods behind a selector-less Service (e.g. one
// backed by manually managed Endpoints) via its Endpoints object.
func podsFromEndpoints(ctx context.Context, cs kubernetes.Interface, namespace, serviceName string) ([]Pod, error) {
	ep, err := cs.CoreV1().Endpoints(namespace).Get(ctx, serviceName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("getting endpoints for service %q: %w", serviceName, err)
	}

	var out []Pod
	seen := make(map[string]bool)
	for _, subset := range ep.Subsets {
		for _, addr := range subset.Addresses {
			if addr.TargetRef == nil || addr.TargetRef.Kind != "Pod" || seen[addr.TargetRef.Name] {
				continue
			}
			seen[addr.TargetRef.Name] = true
			p, err := cs.CoreV1().Pods(namespace).Get(ctx, addr.TargetRef.Name, metav1.GetOptions{})
			if err != nil {
				continue
			}
			out = append(out, toPod(*p))
		}
	}
	return out, nil
}
