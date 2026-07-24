package k8s

import (
	"context"
	"fmt"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
)

// RestartWorkload triggers a rolling restart of a Deployment (equivalent to
// `kubectl rollout restart`), or of the single Deployment backing a Service.
func (m *Manager) RestartWorkload(ctx context.Context, contextName, namespace, kind, name string) error {
	cs, err := m.ClientsetFor(contextName)
	if err != nil {
		return err
	}

	switch kind {
	case "deployment":
		return restartDeployment(ctx, cs, namespace, name)
	case "service":
		depName, err := deploymentForService(ctx, cs, namespace, name)
		if err != nil {
			return err
		}
		return restartDeployment(ctx, cs, namespace, depName)
	default:
		return fmt.Errorf("unknown workload kind %q", kind)
	}
}

// restartDeployment patches the pod template with a restartedAt annotation,
// the same mechanism kubectl uses, which causes the Deployment's
// ReplicaSet(s) to roll pods over.
func restartDeployment(ctx context.Context, cs kubernetes.Interface, namespace, name string) error {
	patch := fmt.Sprintf(
		`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":%q}}}}}`,
		time.Now().Format(time.RFC3339),
	)
	_, err := cs.AppsV1().Deployments(namespace).Patch(ctx, name, types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("restarting deployment %q: %w", name, err)
	}
	return nil
}

// deploymentForService resolves the single Deployment that owns all of a
// Service's backing pods (Pod -> ReplicaSet -> Deployment), so a Service row
// in the UI can also offer a restart action. Returns an error if the pods
// aren't all owned by exactly one Deployment.
func deploymentForService(ctx context.Context, cs kubernetes.Interface, namespace, serviceName string) (string, error) {
	pods, err := podsForServiceSelector(ctx, cs, namespace, serviceName)
	if err != nil {
		return "", err
	}
	if len(pods) == 0 {
		return "", fmt.Errorf("service %q has no backing pods to restart", serviceName)
	}

	var depName string
	for _, pod := range pods {
		rsName := ""
		for _, ref := range pod.OwnerReferences {
			if ref.Kind == "ReplicaSet" {
				rsName = ref.Name
				break
			}
		}
		if rsName == "" {
			return "", fmt.Errorf("pod %q is not owned by a ReplicaSet; can't determine its Deployment", pod.Name)
		}

		rs, err := cs.AppsV1().ReplicaSets(namespace).Get(ctx, rsName, metav1.GetOptions{})
		if err != nil {
			return "", fmt.Errorf("getting replicaset %q: %w", rsName, err)
		}

		name := ""
		for _, ref := range rs.OwnerReferences {
			if ref.Kind == "Deployment" {
				name = ref.Name
				break
			}
		}
		if name == "" {
			return "", fmt.Errorf("replicaset %q is not owned by a Deployment", rsName)
		}

		if depName == "" {
			depName = name
		} else if depName != name {
			return "", fmt.Errorf("service %q maps to more than one Deployment; restart the Deployments individually", serviceName)
		}
	}
	return depName, nil
}
