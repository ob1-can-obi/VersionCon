# VersionCon Relay

A dumb byte-forwarder that lets [VersionCon](../README.md) teams collaborate across networks via a relay server you self-host. The relay never inspects message payloads — it routes WebSocket frames between host and members by `sessionId` and forwards the original bytes verbatim. Host and members terminate the protocol; the relay just brokers connections across NAT boundaries so users on different networks can collaborate as if they were on the same LAN.

See [`.planning/phases/07-cloud-mode-relay-server/07-CONTEXT.md`](../.planning/phases/07-cloud-mode-relay-server/07-CONTEXT.md) for the architectural decisions behind this design.

---

## When to deploy this

**Use LAN mode** (the default) when your team is on the same network — office Wi-Fi, in-person sprint, home network with everyone present. LAN mode is faster, needs no relay, and has zero ongoing cost. It is the default in the VersionCon wizard.

**Deploy this relay** when team members are on different networks — remote work across cities, contractors in a different country, members on cellular, employee at a coffee shop. VersionCon's Cloud mode connects host and members over the public internet via a relay you operate. The relay sees encrypted-in-transit WebSocket frames and forwards them, but never reads message contents. You control the box, the logs, and the data retention. Nothing leaves your infrastructure unless you put it there.

---

## Deploy on Fly.io (≤5 min)

Fly.io has the best UX for this shape: one command (`fly launch`) gives you a TLS-terminated HTTPS endpoint with Let's Encrypt, a managed Docker build, and global routing. We recommend it as the cheapest commercial option.

> **Cost note:** Fly.io's free tier **was discontinued for new accounts on 2024-10-07**. Expect approximately **$2-5/month** for a small relay (one `shared-cpu-1x` 256mb machine + minimal egress). Existing Fly.io users on legacy plans keep their old free allowance (3× `shared-cpu-1x` machines + 100GB egress in NA/EU). See [Fly.io pricing](https://fly.io/docs/about/pricing/) for current numbers.

### Prerequisites

- **Node 20+** ([download](https://nodejs.org)) — for local builds and tests
- **Docker** ([install](https://docs.docker.com/get-docker/)) — optional locally; Fly.io's remote builder works without it
- **flyctl** — the Fly.io CLI: `brew install flyctl` (macOS) or `iwr fly.io/install.ps1 -useb | iex` (Windows PowerShell) or see [install docs](https://fly.io/docs/hands-on/install-flyctl/)
- **Fly.io account** — [sign up](https://fly.io/app/sign-up) (a credit card is required for new accounts since 2024-10-07)

### Step 1: Clone and enter the relay directory

```bash
git clone https://github.com/<your-org>/VersionCon.git
cd VersionCon/relay
```

The `relay/` directory is a self-contained npm package. It does not depend on any code in `../src/` (the extension). You can copy this directory to a different repo if you want to manage relay deployments separately.

### Step 2: Authenticate with Fly.io

```bash
fly auth login
```

Opens a browser window. Sign in or create your account.

### Step 3: Launch the app

```bash
fly launch --copy-config --no-deploy
```

The `--copy-config` flag tells `fly launch` to use the included `fly.toml` instead of generating a new one. The `--no-deploy` flag lets you review settings before the first deploy.

flyctl will ask you:

- **App name**: pick something memorable — e.g. `myteam-versioncon-relay`. This becomes part of your relay URL: `wss://myteam-versioncon-relay.fly.dev`.
- **Region**: defaults to `iad` (Virginia). Pick the region closest to your team's geographic median.
- **Postgres / Redis / Tigris**: answer **No** to all. The relay holds state in memory only and needs no managed services.

### Step 4: Deploy

```bash
fly deploy
```

First deploy takes 1-2 minutes (build + image upload + health check). On success you'll see:

```
Visit your newly deployed app at https://myteam-versioncon-relay.fly.dev/
```

### Step 5: Verify with `/healthz`

```bash
curl https://myteam-versioncon-relay.fly.dev/healthz
```

Expected response:

```json
{"ok":true,"sessions":0,"uptime_s":12}
```

`sessions` is the number of active VersionCon sessions on this relay. `uptime_s` is seconds since process start. If you see a 404 or connection-refused error, see [Troubleshooting](#troubleshooting) below.

### Step 6: Connect from VersionCon

Open VS Code with the VersionCon extension. Run **VersionCon: Host Session** from the Command Palette. In the wizard:

1. Enter your display name.
2. On "Where will your team connect from?", choose **Different networks (Cloud)**.
3. Paste your relay URL into the Relay URL field: `wss://myteam-versioncon-relay.fly.dev`.
4. Click **Test connection** — the wizard pings `/healthz` and shows a green check.
5. Continue through the wizard. Finish and copy the deep-link from the "Share invite" screen — it looks like `vscode://versioncon.versioncon/join?relay=...&session=...&code=...`.
6. Send the deep-link to a teammate (Slack, email, anything). They click it; VS Code opens with the join wizard pre-filled with relay + session ID. They type their display name + invite code and they're in.

You're now collaborating across networks. See the top-level [README's Lifecycle Tour](../README.md#lifecycle-tour) for the full workflow.

---

## Environment variable reference

The relay reads the following env vars at startup. All have safe defaults; set them on Fly.io with `fly config env --app <your-app> set KEY=value` for non-secret tuning, or `fly secrets set KEY=value` for anything sensitive (this relay needs no secrets; all values below are safe to set as plain env vars).

| Env var                                       | Default       | Effect                                                                                                                          |
|-----------------------------------------------|---------------|---------------------------------------------------------------------------------------------------------------------------------|
| `PORT`                                        | `8080`        | HTTP/WSS listen port. Fly.io passes its internal port via this; you generally do not set it manually.                           |
| `LOG_LEVEL`                                   | `info`        | pino log level (`debug` / `info` / `warn` / `error` / `fatal` / `silent`). Bumps to `debug` are useful when debugging a deploy. |
| `RELAY_REQUIRE_AUTH`                          | `true`        | Set to `false` for **local development ONLY**. Disables JWT verification on incoming connections. Never set this on a deployed relay. |
| `VERSIONCON_MAX_CONNECTIONS_PER_MIN_PER_IP`   | `30`          | Sliding-window connection rate limit at the WSS upgrade. A flood from one IP is rejected at the cheapest possible check.        |
| `VERSIONCON_MAX_SESSIONS`                     | `1000`        | Reject new `session-register` beyond this cap with WSS close code 4429. Per-process cap.                                        |
| `VERSIONCON_MAX_MEMBERS_PER_SESSION`          | `50`          | Reject new member attach beyond this cap with WSS close code 4429.                                                              |
| `VERSIONCON_MAX_FRAME_BYTES`                  | `1048576`     | Inbound WebSocket frame size cap. 1 MiB default; raise only if your push payloads are large.                                    |
| `VERSIONCON_IDLE_REAP_MINUTES`                | `30`          | Sessions with zero traffic this long are closed. Frees memory; forces reconnect as a fresh session.                             |
| `VERSIONCON_HOST_DROP_GRACE_SECONDS`          | `60`          | Grace period after the host disconnects before the session is torn down. Gives Wi-Fi blips a chance to recover before all member sockets are forcibly closed. |
| `VERSIONCON_TOKEN_TTL` *(host-side, not relay)* | `4h`        | JWT expiry as a [jose timestring](https://github.com/panva/jose) (e.g. `4h`, `30m`, `1d`). **Read by the host VS Code extension when it issues tokens, NOT by the relay.** Setting this on the Fly.io relay app has no effect; set it on each host machine instead (e.g. via the host user's shell env or VS Code's `terminal.integrated.env`). Listed here for completeness — the relay verifies tokens against their baked-in `exp` claim, not against this env var. |

Example — raise the session cap and turn on tracing while debugging:

```bash
fly config env --app myteam-versioncon-relay set VERSIONCON_MAX_SESSIONS=2000 LOG_LEVEL=debug
```

---

## Operational caveats

- **Single-process relay.** v1 holds sessions in memory only. Scaling beyond ~50 concurrent sessions per machine means upgrading to `shared-cpu-2x` 512mb (`fly scale vm shared-cpu-2x --memory 512`). Horizontal scaling (multi-machine session sharding) is a v2 concern.
- **No multi-region routing.** All sessions terminate on the machine in `primary_region`. If you need EU + US presence, deploy two separate relay apps and point each host at the closest one.
- **Do not enable `auto_stop_machines = "stop"`.** Fly.io's auto-stop is HTTP-request-based and does **not** count WebSocket traffic. With auto-stop enabled, the machine idles out after ~5-10 minutes and every active session drops simultaneously. The included `fly.toml` sets `auto_stop_machines = "off"` and `auto_start_machines = true` — this is the manual-stop / auto-wake pairing (you can `fly machine stop` during true off-hours to save cost; the machine wakes automatically when the first joiner connects). Do not "fix" this combination without re-reading this caveat.
- **TLS terminates at the Fly edge.** The relay process itself listens on plain HTTP/WSS on port 8080 inside the container. Fly.io's Anycast proxy upgrades to TLS at the edge via Let's Encrypt. This is normal — do not configure certificates inside the container; the `fly.toml`'s `force_https = true` handles the redirect.
- **Per-session JWT secrets are runtime-only.** The relay generates a 32-byte random secret per session via `crypto.randomBytes(32)` and never persists it. Restart the relay → existing sessions are invalidated (members reconnect via the wizard). This is by design — there is no secret material in `fly.toml` and the relay needs none.
- **Trust boundary.** Fly.io's edge sees plaintext WebSocket frames inside their network (TLS terminates at the edge; relay-to-edge is plain WS internally). End-to-end body encryption is on the roadmap for a future security hardening phase — see [Future roadmap](#future-roadmap). If your threat model excludes trusting the cloud operator with plaintext frames, the v1 relay is not sufficient; self-hosting on your own infrastructure (Hetzner / DigitalOcean droplet / on-prem) is the current workaround.

---

## Troubleshooting

**`/healthz` returns 503 (Service Unavailable):**
Fly's health check has not passed yet. Wait 30s and retry. If it persists, check `fly logs --app <your-app>` for crash logs.

**`wss://` connection drops immediately (close code 503):**
The relay's auth seam is failing closed — likely the deploy is missing a dependency or the build stage failed silently. Run `fly logs` and look for `auth-not-wired` events.

**`wss://` connection drops with close code 4429:**
Hit a rate limit. Either you exceeded 30 connections/min from one IP (per `VERSIONCON_MAX_CONNECTIONS_PER_MIN_PER_IP`), or you exceeded the session cap (1000 sessions per process by default), or the member cap (50 per session). Increase via `fly config env`.

**`wss://` connection drops with close code 4400:**
Bad first frame from the host. The host must send a `session-register` envelope as its first frame after WSS open; any other shape is rejected. This usually means a version mismatch between extension and relay — redeploy the relay from `main` to align.

**Sessions drop after ~10 minutes of inactivity:**
Likely you have `auto_stop_machines = "stop"` set (re-read the auto-stop caveat above), or you raised `VERSIONCON_IDLE_REAP_MINUTES` below your team's typical idle gaps. Check both.

**Cost is higher than expected:**
Run `fly status` and `fly scale show` — if you have more than one machine, scale down with `fly scale count 1`. Egress is the variable cost; if egress is high, investigate whether a stuck client is reconnecting in a loop (look for `connection-open` storms in `fly logs`).

**My team needs >100 concurrent sessions:**
Upgrade VM size: `fly scale vm shared-cpu-2x --memory 512`. v1 is not designed for thousands of concurrent sessions on one machine — that is a future-phase scaling concern.

---

## Deploy elsewhere

The relay is a standard Node.js application packaged via the included `Dockerfile`. The same image works on any Docker-capable platform. We document Fly.io because the UX is exceptional, but you are not locked in.

- **AWS Fargate**: build the image with `docker build -t versioncon-relay .`, push to ECR, create an ECS task definition with the image, expose port 8080 behind an Application Load Balancer with an HTTPS listener (ACM certificate). Roughly $15-30/month for a small instance.
- **Hetzner Cloud**: spin up a CX11 instance (~€4.51/month), install Docker, run the image directly with `docker run -d -p 8080:8080 --restart unless-stopped versioncon-relay`. Front with [Caddy](https://caddyserver.com/) or [Traefik](https://traefik.io/) for automatic Let's Encrypt TLS.
- **DigitalOcean App Platform**: connect a Git repo with the `relay/` directory, App Platform builds via the Dockerfile, managed TLS included. ~$5/month for the basic XXS plan.

Any of these gives you the same `wss://your-domain` endpoint that VersionCon's wizard expects.

---

## Future roadmap

A **managed relay service at `versioncon.dev`** is on the roadmap for a future business/ops phase — pay-monthly, no self-host, regional deployment, abuse handling, status page. See [CONTEXT §Deferred Ideas](../.planning/phases/07-cloud-mode-relay-server/07-CONTEXT.md) for context. No delivery date.

Also deferred to a future security hardening phase: end-to-end body encryption (the relay sees only encrypted ciphertext, not plaintext frames), SSO / SAML / SCIM, structured audit logs, signed release artifacts, JWT refresh + revocation. The v1 relay ships architectural seams for these — the JWT claim schema is SSO-ready, the wire envelope has an `encrypted` flag (always `false` in v1), and the protocol layer is decoupled from the byte-forwarder layer so a future `CryptoTransport` decorator drops in without touching the relay code.

---

## Links

- [Top-level VersionCon README](../README.md)
- [Phase 7 planning context](../.planning/phases/07-cloud-mode-relay-server/07-CONTEXT.md) (for contributors)
- [Fly.io WebSockets docs](https://fly.io/blog/websockets-and-fly/)
- [Fly.io pricing](https://fly.io/docs/about/pricing/)
- [jose JWT library](https://github.com/panva/jose) (the relay's JWT verifier; pinned to `^5.10.0`)
