# EdgeFlow Load Balancer

A dependency-free Node.js HTTP/1.1 reverse proxy for three containerized backend replicas. It demonstrates health-aware traffic routing, bounded failover, rate limiting, observability, and deployment through Docker Compose or Kubernetes manifests.

This is a portfolio infrastructure project. It does not recreate Kubernetes. Kubernetes schedules the containers; EdgeFlow implements application-layer routing between explicitly configured upstream services.

```mermaid
flowchart LR
  Client --> Gateway[EdgeFlow gateway]
  Gateway --> A[backend-a]
  Gateway --> B[backend-b]
  Gateway --> C[backend-c]
  Gateway --> Metrics[/metrics]
  Gateway --> Health[/readyz and /livez]
```

## Backend engineering features

- **Health-aware weighted round robin:** active `/healthz` probes remove unavailable backends from the candidate pool. Configuration validation rejects duplicate IDs, invalid weights, and non-HTTP origins.
- **Bounded failover:** only body-free `GET` and `HEAD` requests retry, and only on a transport failure or a 502/503/504 response. Writes are never replayed by the gateway.
- **Passive ejection:** three consecutive server-side failures temporarily remove an upstream for five seconds. Health probes and the cooldown must both permit routing again.
- **Streaming proxy:** request and response bodies use Node streams rather than whole-body buffering. Hop-by-hop headers are removed, client-supplied forwarding headers are replaced, and every request gets a new request ID.
- **Rate limiting:** a per-client token bucket limits requests and caps the number of client records held in memory.
- **Operational endpoints:** `/livez`, `/readyz`, and Prometheus-format `/metrics` expose process health, upstream availability, in-flight requests, request totals, and attempt outcomes. Logs are structured JSON.
- **Graceful shutdown:** the gateway stops accepting connections on SIGTERM/SIGINT and gives active requests up to ten seconds to drain.

## Layout

- `src/gateway.js` owns the HTTP server and lifecycle.
- `src/proxy.js` streams traffic and applies retry rules.
- `src/pool.js` selects healthy upstreams and handles passive ejection.
- `src/health.js`, `src/limiter.js`, and `src/metrics.js` isolate probing, throttling, and telemetry.
- `src/backend.js` is a small echo service used to demonstrate routing and failure handling.
- `config/` contains local and Docker Compose upstream addresses.
- `k8s/all.yaml` contains a ConfigMap, two gateway replicas, three backend Deployments, Services, and health probes.

## Run with Docker Compose

From this directory:

```sh
docker compose up --build
```

The gateway listens on `http://localhost:8080`. Once `/readyz` returns 200, send several requests:

```sh
curl http://localhost:8080/readyz
curl http://localhost:8080/work
curl http://localhost:8080/work
curl http://localhost:8080/metrics
```

The response has an `instance` field, and the `x-edgeflow-upstream` header identifies the chosen backend. Repeated `/work` calls rotate between healthy replicas. `GET /unstable` returns 503 from `backend-c` and allows the gateway to retry another replica. To observe active health removal, stop one backend and wait for the next probe:

```sh
docker compose stop backend-b
curl http://localhost:8080/work
```

`POST /work` echoes the byte count and is **not** retried. The demo backend rejects bodies larger than 1 MiB. The gateway's token bucket defaults to 20 requests per second with a burst of 40 for each directly connected client address.

## Run with local Node.js

Requires Node.js 24 or newer. Start the backends in separate terminals:

```sh
INSTANCE_ID=backend-a PORT=9001 node src/backend.js
INSTANCE_ID=backend-b PORT=9002 node src/backend.js
INSTANCE_ID=backend-c PORT=9003 node src/backend.js
```

Then start the gateway from this directory:

```sh
CONFIG_PATH=./config/local.json node src/gateway.js
```

## Kubernetes manifests

The manifests use the local image name `edgeflow-load-balancer:local`. Build it and make it available to your cluster before applying the manifests. For a `kind` cluster, for example:

```sh
docker build -t edgeflow-load-balancer:local .
kind load docker-image edgeflow-load-balancer:local
kubectl apply -f k8s/all.yaml
kubectl port-forward service/edgeflow-gateway 8080:8080
```

For a remote cluster, push the image to a registry and replace the image reference in `k8s/all.yaml`. The Kubernetes Service routes clients to two gateway pods; each gateway routes to three backend Services. Gateway readiness requires at least one healthy upstream in every configured route. The pods use non-root users, read-only root filesystems, resource limits, and liveness/readiness probes.

## API behavior and design limits

All non-reserved paths forward to the selected backend. The gateway reserves `/livez`, `/readyz`, and `/metrics`. It supports HTTP/1.1 only; TLS termination, WebSocket upgrades, dynamic service discovery, and configuration reload are outside this demo. The rate limiter and routing state are local to each gateway replica, so a multi-replica deployment needs shared state if a global limit is required. Protect `/metrics` and add TLS at an ingress before exposing this beyond a local environment.

The demo's `/unstable` endpoint and failure handling are synthetic. They do not measure production availability or throughput. No external load balancer or payment provider is contacted.
