#!/usr/bin/env bash
# Stand up a local Argo CD for integration testing.
#
# CI runs this across the three supported minors. Run it locally to exercise the
# tasks against a real server.
#
#   ./scripts/kind-argocd.sh 3.5.3
#   source .argocd-env && npx vitest run test/integration
#
# CI sets PERSIST_PORT_FORWARD=true so the tunnel survives the script exiting and remains
# usable by later workflow steps, and CREATE_SAMPLE_APP=true so there is an application to
# act on.
#
# Two things here are not optional:
#
#   * --server-side --force-conflicts on the install. From Argo CD 3.3 the ApplicationSet
#     CRD exceeds the client-side-apply annotation size limit, so a plain `kubectl apply`
#     fails outright.
#   * An apiKey account rather than the admin user. Admin session JWTs expire after 24h and
#     bypass the RBAC path the tasks actually run through, so testing with admin tests the
#     wrong thing.
set -euo pipefail

ARGOCD_VERSION="${1:-3.5.3}"
CLUSTER_NAME="${CLUSTER_NAME:-argocd-test}"
NAMESPACE=argocd
ACCOUNT=ci-test
LOCAL_PORT="${LOCAL_PORT:-8080}"
ENV_FILE="${ENV_FILE:-.argocd-env}"
PERSIST_PORT_FORWARD="${PERSIST_PORT_FORWARD:-false}"
CREATE_SAMPLE_APP="${CREATE_SAMPLE_APP:-false}"
SAMPLE_APP="${SAMPLE_APP:-guestbook}"

for tool in docker kind kubectl argocd; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "Missing required tool: $tool" >&2
        echo "  docker:  required to pre-pull images and for kind to create the cluster" >&2
        echo "  kind:    https://kind.sigs.k8s.io/docs/user/quick-start/#installation" >&2
        echo "  argocd:  https://argo-cd.readthedocs.io/en/stable/cli_installation/" >&2
        exit 1
    }
done

# Host-side pull with retries/backoff. In-cluster pulls (especially public.ecr.aws
# redis) flake under rate limits; docker on the runner is the only place a retry
# actually helps. Skip the pull when the image is already local so a re-run is
# not held hostage by the same registry blip.
pull_image() {
    local image="$1"
    local attempt=1
    local delay=5
    local max_attempts=5
    if docker image inspect "${image}" >/dev/null 2>&1; then
        echo "    already present: ${image}"
        return 0
    fi
    while true; do
        echo "    docker pull ${image} (attempt ${attempt}/${max_attempts})"
        if docker pull "${image}"; then
            return 0
        fi
        if [[ "${attempt}" -ge "${max_attempts}" ]]; then
            echo "Failed to pull ${image} after ${max_attempts} attempts" >&2
            return 1
        fi
        echo "    pull failed; retrying in ${delay}s"
        sleep "${delay}"
        attempt=$((attempt + 1))
        delay=$((delay * 2))
    done
}

# On a timed-out rollout, dump pod describe so ImagePullBackOff (and similar)
# shows up in CI logs instead of only "error: timed out waiting for the condition".
wait_rollout() {
    local resource="$1"
    if kubectl rollout status -n "${NAMESPACE}" "${resource}" --timeout=300s; then
        return 0
    fi
    echo "==> ${resource} failed to become ready; dumping pod state" >&2
    kubectl get pods -n "${NAMESPACE}" -o wide || true
    kubectl describe pods -n "${NAMESPACE}" || true
    return 1
}

echo "==> Creating kind cluster '${CLUSTER_NAME}'"
kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}" || kind create cluster --name "${CLUSTER_NAME}"
kubectl cluster-info --context "kind-${CLUSTER_NAME}" >/dev/null

echo "==> Installing Argo CD v${ARGOCD_VERSION}"
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

INSTALL_MANIFEST=$(mktemp)
# --proto '=https' refuses an http:// redirect, which curl -L would otherwise follow.
curl -fsSL --proto '=https' --tlsv1.2 --retry 5 --retry-delay 5 \
    -o "${INSTALL_MANIFEST}" \
    "https://raw.githubusercontent.com/argoproj/argo-cd/v${ARGOCD_VERSION}/manifests/install.yaml"

# Kind nodes pull from the public registry on first use. That is the flake:
# GitHub runners hitting public.ecr.aws (redis) or quay.io occasionally get
# rate-limited, the pod sits in ImagePullBackOff, and `rollout status` times
# out after five minutes with argocd-server logging
# `dial tcp ...:6379: connection refused`. Pull every image the install
# manifest references on the host, then load them into the cluster so kubelet
# never has to talk to a registry.
echo "==> Pre-loading images into the kind cluster"
images=()
while IFS= read -r image; do
    [[ -n "${image}" ]] || continue
    images+=("${image}")
done < <(grep -E '^[[:space:]]+image:[[:space:]]+' "${INSTALL_MANIFEST}" \
    | sed -E 's/^[[:space:]]+image:[[:space:]]+//; s/^["'\'']//; s/["'\'']$//; s/[[:space:]]+#.*$//; s/[[:space:]]+$//' \
    | sort -u)

if [[ "${#images[@]}" -eq 0 ]]; then
    echo "No container images found in the Argo CD v${ARGOCD_VERSION} install manifest" >&2
    rm -f "${INSTALL_MANIFEST}"
    exit 1
fi

for image in "${images[@]}"; do
    pull_image "${image}"
done
kind load docker-image "${images[@]}" --name "${CLUSTER_NAME}"

# Argo CD's install sets imagePullPolicy: Always on redis, dex, and most of
# the argocd containers. With Always, kubelet still contacts the registry
# even after `kind load`, which is exactly the flake. IfNotPresent uses the
# image we just loaded. awk rather than sed -i so this is the same on GNU
# and BSD.
awk '{sub(/imagePullPolicy: Always/, "imagePullPolicy: IfNotPresent")} {print}' \
    "${INSTALL_MANIFEST}" > "${INSTALL_MANIFEST}.ifnotpresent"
mv "${INSTALL_MANIFEST}.ifnotpresent" "${INSTALL_MANIFEST}"

kubectl apply -n "${NAMESPACE}" --server-side --force-conflicts -f "${INSTALL_MANIFEST}"
rm -f "${INSTALL_MANIFEST}"

echo "==> Waiting for Argo CD to become available"
# All of these must be up, not just the API server: the server and repo-server both cache
# through redis, and a missing redis surfaces to the client as an opaque HTTP 500
# ("dial tcp ...:6379: connection refused") rather than as a readiness problem.
for deploy in argocd-redis argocd-repo-server argocd-server argocd-applicationset-controller; do
    wait_rollout "deployment/${deploy}"
done
wait_rollout statefulset/argocd-application-controller

echo "==> Creating the '${ACCOUNT}' apiKey account"
kubectl patch configmap argocd-cm -n "${NAMESPACE}" --type merge \
    -p "{\"data\":{\"accounts.${ACCOUNT}\":\"apiKey\"}}"
kubectl patch configmap argocd-rbac-cm -n "${NAMESPACE}" --type merge \
    -p "{\"data\":{\"policy.default\":\"\",\"policy.csv\":\"p, role:${ACCOUNT}, applications, *, */*, allow\\np, role:${ACCOUNT}, applicationsets, *, */*, allow\\np, role:${ACCOUNT}, projects, get, *, allow\\np, role:${ACCOUNT}, logs, get, */*, allow\\np, role:${ACCOUNT}, exec, create, */*, allow\\ng, ${ACCOUNT}, role:${ACCOUNT}\\n\"}}"
kubectl rollout restart -n "${NAMESPACE}" deployment/argocd-server
wait_rollout deployment/argocd-server

echo "==> Port-forwarding argocd-server to localhost:${LOCAL_PORT}"
# kubectl port-forward drops its connection on longer runs -- it is a single TCP
# tunnel with no recovery. A multi-minute integration suite will outlive it, and every
# request after the drop fails with an opaque TLS error that looks like a client bug.
# Supervise it so the tunnel comes back instead.
(
    while true; do
        kubectl port-forward -n "${NAMESPACE}" svc/argocd-server "${LOCAL_PORT}:443" >/dev/null 2>&1 || true
        sleep 1
    done
) &
PORT_FORWARD_PID=$!
if [ "${PERSIST_PORT_FORWARD}" != "true" ]; then
    # Kill the supervisor and whatever kubectl it currently owns.
    trap 'kill "${PORT_FORWARD_PID}" 2>/dev/null || true; pkill -f "port-forward.*${LOCAL_PORT}:443" 2>/dev/null || true' EXIT
fi

# Wait for the tunnel to actually answer rather than guessing at a sleep.
for _ in $(seq 1 30); do
    if curl -sk --max-time 2 "https://localhost:${LOCAL_PORT}/api/version" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

ADMIN_PASSWORD=$(kubectl get secret -n "${NAMESPACE}" argocd-initial-admin-secret \
    -o jsonpath='{.data.password}' | base64 -d)

echo "==> Minting an API token for '${ACCOUNT}'"
argocd login "localhost:${LOCAL_PORT}" --username admin --password "${ADMIN_PASSWORD}" --insecure --grpc-web
TOKEN=$(argocd account generate-token --account "${ACCOUNT}" --insecure --grpc-web)

if [ "${CREATE_SAMPLE_APP}" = "true" ]; then
    echo "==> Creating the '${SAMPLE_APP}' sample application"
    kubectl apply -n "${NAMESPACE}" -f - <<APP
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${SAMPLE_APP}
spec:
  project: default
  source:
    repoURL: https://github.com/argoproj/argocd-example-apps.git
    targetRevision: HEAD
    path: guestbook
  destination:
    server: https://kubernetes.default.svc
    namespace: ${SAMPLE_APP}
  syncPolicy:
    syncOptions:
      - CreateNamespace=true
APP
    # Wait for a first status, then actually SYNC it. Creating the application only
    # registers it; with no auto-sync policy it stays OutOfSync/Missing, and a status
    # check against a never-deployed application correctly fails.
    kubectl wait -n "${NAMESPACE}" --for=jsonpath='{.status.sync.status}' \
        --timeout=180s "application/${SAMPLE_APP}" 2>/dev/null || \
        echo "    (proceeding; the application has not reported a sync status yet)"

    echo "==> Syncing '${SAMPLE_APP}' so the fixture starts healthy"
    argocd app sync "${SAMPLE_APP}" --insecure --grpc-web --timeout 300 || \
        echo "    (sync reported a problem; continuing so the tests can report it)"
    argocd app wait "${SAMPLE_APP}" --sync --health --insecure --grpc-web --timeout 300 || \
        echo "    (application did not become healthy in time)"
fi

cat > "${ENV_FILE}" <<ENV
# Generated by scripts/kind-argocd.sh -- do not commit.
export ARGOCD_TEST_SERVER="https://localhost:${LOCAL_PORT}"
export ARGOCD_TEST_TOKEN="${TOKEN}"
export ARGOCD_TEST_INSECURE=true
export ARGOCD_TEST_VERSION="${ARGOCD_VERSION}"
ENV

echo
echo "Argo CD v${ARGOCD_VERSION} is ready."
echo "  UI:    https://localhost:${LOCAL_PORT}  (admin / ${ADMIN_PASSWORD})"
echo "  Env:   source ${ENV_FILE}"
echo
echo "The port-forward stops when this script exits. Keep it running, or re-run:"
echo "  kubectl port-forward -n ${NAMESPACE} svc/argocd-server ${LOCAL_PORT}:443"
echo
echo "Tear down with: kind delete cluster --name ${CLUSTER_NAME}"

if [ "${PERSIST_PORT_FORWARD}" = "true" ]; then
    echo "Port-forward left running as PID ${PORT_FORWARD_PID}."
else
    wait "${PORT_FORWARD_PID}"
fi
