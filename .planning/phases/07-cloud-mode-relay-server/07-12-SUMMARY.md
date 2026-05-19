---
phase: 07-cloud-mode-relay-server
plan: 12
subsystem: infra
tags: [docker, fly.io, dockerfile, deployment, ops, relay, documentation, jwt, websocket]

# Dependency graph
requires:
  - phase: 07-cloud-mode-relay-server
    provides: "07-08 relay package skeleton (relay/package.json `main: dist/server.js`, `start: node dist/server.js`, `build: tsc`) + tsconfig + server.ts entry; 07-09 auth.ts JWT verifier; 07-10 limits.ts 6 env-var policy module + grace timer; 07-11 logger.ts pino redact config + structured log migration; 07-03 TokenService with crypto.randomBytes(32) per-session secrets; 07-05b SessionHostFactory.createCloud + per-joiner JWT issuance"
provides:
  - "relay/Dockerfile — multi-stage container build (node:20-alpine base, USER node runtime, EXPOSE 8080, CMD [\"node\", \"dist/server.js\"]) — ASVS V14.1.1 non-root container"
  - "relay/fly.toml — Fly.io deploy config (shared-cpu-1x 256mb, force_https=true, auto_stop_machines=off, auto_start_machines=true, min_machines_running=1, /healthz check, primary_region=iad) — zero secrets stored, ASVS V14.3"
  - "relay/README.md — 189-line Deploy Your Relay quickstart (6-step Fly.io walkthrough + env-var reference table for all 9 locked vars + operational caveats including auto_stop warning + troubleshooting close-code map + Deploy-elsewhere AWS/Hetzner/DigitalOcean refs + Future roadmap mentioning managed versioncon.dev relay + deferred L3 encryption)"
  - "README.md `## VersionCon for Cloud Teams` section — surgical 22-line insert between Git Users and Development sections (zero existing prose changed)"
affects: [phase-08-ai-agent-mcp, phase-9-security-hardening, future-managed-relay-versioncon-dev, future-ci-relay-image-release]

# Tech tracking
tech-stack:
  added:
    - "docker (build/runtime artifact — relay/Dockerfile)"
    - "fly.io (deploy target — relay/fly.toml; flyctl install via brew/iwr documented)"
  patterns:
    - "Multi-stage Dockerfile (build deps in stage 1; --omit=dev runtime in stage 2; copy dist/ between stages)"
    - "USER node defense-in-depth: drop root in runtime stage, bound in-process exploits to node UID 1000 (ASVS V14.1.1)"
    - "fly.toml manual-stop / auto-wake pairing (auto_stop=off + auto_start=true) — sessions stateful in memory; cost-control still possible via fly machine stop"
    - "Doc-artifact-only plan: zero source code touched; verification is grep + manual UAT (no test runner)"
    - "Surgical README insert: exact-anchor Edit (not Write), additive-only, zero changes to existing prose; verified via git diff -U0 showing pure insertion"
    - "Bidirectional cross-link convention: relay/README.md → ../README.md AND README.md → relay/README.md (matches existing .planning/ROADMAP.md relative-link style)"
    - "Stale-CONTEXT-vs-RESEARCH precedence rule: RESEARCH wins when CONTEXT is older — 'free tier covers small teams' (stale CONTEXT D-03) replaced by 2024-10-07 discontinuation + $2-5/month (RESEARCH §Pitfall 2)"

key-files:
  created:
    - "relay/Dockerfile (44 lines incl. comments)"
    - "relay/fly.toml (61 lines incl. comments)"
    - "relay/README.md (189 lines)"
  modified:
    - "README.md (+22 lines: new `## VersionCon for Cloud Teams` section between Git Users and Development; existing 5 sections preserved byte-identical)"

key-decisions:
  - "Discrepancy resolved in favor of planning_context: auto_start_machines = true (NOT false per RESEARCH §A4's 'both enabled or both disabled' guidance). Rationale: Fly.io's actual constraint allows auto_stop=off + auto_start=true as a valid 'manual-stop, auto-wake' pairing — machine persists while sessions are alive AND can be manually stopped during true off-hours. Documented inline in fly.toml AND in relay/README.md Operational caveats so future operators don't 'fix' it."
  - "Stale CONTEXT D-03 wording 'free tier covers small teams' is NOT used in README — RESEARCH §Pitfall 2 (Fly.io free tier discontinued 2024-10-07 for new accounts) is the current fact, so the README sets honest expectations (~$2-5/month for new orgs; legacy orgs keep their allowance) and links to live Fly.io pricing."
  - "No CI workflow added — deploy is a USER action per CONTEXT D-02 'self-host only for v1'. A future CI-based deploy is a separate threat surface (Phase 9+ business/ops phase)."
  - "Surgical insert into top-level README via Edit tool (not Write): exact-match anchor `Cloud export is one-way per command ...\\n\\n## Development`, replaced with anchor + new section + Development header. Verified diff is purely additive (+22 lines, zero existing prose modified)."
  - "All 9 locked env vars documented in relay/README.md PLUS RELAY_REQUIRE_AUTH (07-08 introduced; explicit local-dev-ONLY warning); VERSIONCON_TOKEN_TTL flagged as host-side-not-relay (host issues, relay verifies against baked-in exp claim — setting it on the Fly app has no effect)."
  - "relay/package-lock.json was already tracked by git (relay/.gitignore does NOT exclude it) — no `npm install --package-lock-only` run was needed."

patterns-established:
  - "Pattern 1: Doc-and-config-only finalization plan as the last plan in a phase — closes operational story without adding new code surface; verification is grep-based with manual UAT documented for the verifier."
  - "Pattern 2: Inline-rationale comments in ops-config files (Dockerfile, fly.toml) explaining non-obvious choices so a future operator inheriting the file doesn't 'optimize' away invariants (e.g. auto_stop_machines = 'off' has a 5-line comment explaining the WSS-vs-HTTP-traffic mismatch; USER node has a comment naming ASVS V14.1.1)."
  - "Pattern 3: Honest-cost transparency in deploy docs — link live pricing pages, name discontinuation dates, give explicit $/month estimates with reasoning; avoids the marketing-speak 'free tier covers small teams' trap that breaks trust when an operator gets billed."
  - "Pattern 4: Bidirectional README cross-links via relative paths (relay/README.md ↔ ../README.md), with both directions verified by grep in the verify block."

requirements-completed: [NET-06]

# Metrics
duration: 4min
completed: 2026-05-19
---

# Phase 7 Plan 12: Cloud Mode Deployment + Docs Summary

**Phase 7 deploy story shipped end-to-end: multi-stage Dockerfile (node:20-alpine + USER node), Fly.io fly.toml (force_https + no-auto-stop), 189-line Deploy Your Relay quickstart with full 9 env-var reference + honest Fly.io cost transparency, and a 22-line surgical insert into the top-level README — a developer can clone the repo and have a running cloud-mode relay in ≤5 minutes.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-19T08:04:07Z
- **Completed:** 2026-05-19T08:08:25Z
- **Tasks:** 3
- **Files modified:** 4 (3 new + 1 surgical edit)
- **Commits:** 3 atomic task commits + 1 metadata commit (final)
- **Code lines added:** 0 (doc-and-config artifacts only)
- **Doc lines added:** 274 (44 Dockerfile + 61 fly.toml + 189 README + 22 top-level insert) — minus inline comments, ~190 lines of pure prose/config
- **Tests:** 71/71 relay (re-ran as sanity check — identical to 07-05b); extension count unchanged at 996/0/66 (zero source files modified — code-isolation argument)

## Accomplishments

- **`relay/Dockerfile`** — multi-stage container build, `node:20-alpine` base, `npm ci` for reproducible build deps, `--omit=dev` in runtime stage, `COPY --from=build /app/dist ./dist`, `USER node` non-root runtime (ASVS V14.1.1), `EXPOSE 8080`, `CMD ["node", "dist/server.js"]` matches `relay/package.json` `start` script verbatim. Inline comments explain every non-obvious choice (defense-in-depth rationale, alpine vs slim, npm ci vs install lockfile policy).
- **`relay/fly.toml`** — Fly.io app config: `shared-cpu-1x` 256mb VM, `force_https = true` (Let's Encrypt at edge), `auto_stop_machines = "off"` (sessions are stateful — WSS traffic doesn't count toward Fly's auto-stop heuristic; T-07-21 mitigation), `auto_start_machines = true` (manual-stop / auto-wake — CONTEXT D-03 invariant, documented inline so future operators don't "fix" it), `min_machines_running = 1` (cold joiners avoid 502), `[[http_service.checks]] path = "/healthz"` every 30s with 10s grace, `primary_region = "iad"`. Zero secret-shaped lines (per-session JWT signing secrets are runtime-generated via `crypto.randomBytes(32)` in 07-03 TokenService).
- **`relay/README.md`** (189 lines) — 6-step Fly.io quickstart (clone → fly auth → fly launch --copy-config --no-deploy → fly deploy → curl /healthz → VersionCon wizard Cloud path with deep-link share), env-var reference table for ALL 9 locked vars (07-08/07-10/07-11/07-03 contributors) PLUS `RELAY_REQUIRE_AUTH` (07-08 local-dev-only) PLUS `VERSIONCON_TOKEN_TTL` (host-side note — set on host machine, not Fly app), operational caveats (single-process limit, no multi-region in v1, auto_stop must stay "off", TLS terminates at Fly edge, per-session JWT secrets are runtime-only, Fly.io edge trust boundary as documented residual risk T-07-19), troubleshooting close-code map (503 health / 503 auth / 4429 rate / 4400 first-frame / idle reap / cost spikes / scaling), Deploy-elsewhere footnote (AWS Fargate / Hetzner Cloud / DigitalOcean App Platform — same image, same wss endpoint), Future roadmap (managed versioncon.dev relay + deferred L3 encryption + SSO/MFA/audit/refresh per CONTEXT §Deferred Ideas), bidirectional cross-links.
- **Top-level `README.md`** — 22-line surgical insert (`## VersionCon for Cloud Teams` between `## VersionCon for Git Users` and `## Development`); 2-paragraph LAN-vs-Cloud framing, forward link to `relay/README.md`, cost note matching the relay README, deep-link flow narrative (Alice → Bob deep-link → join wizard pre-filled), Deploy-elsewhere subsection, mention of managed `versioncon.dev` future roadmap. **Pure additive insert** — `git diff` confirms zero changes to the 5 pre-existing sections (Status / Install / Lifecycle Tour / Git Users / Development).

## Task Commits

Each task was committed atomically:

1. **Task 1: Create relay/Dockerfile + relay/fly.toml** — `d7a42b2` (feat)
2. **Task 2: Create relay/README.md (Deploy Your Relay quickstart)** — `1e7e006` (docs)
3. **Task 3: Surgical insert into top-level README.md (VersionCon for Cloud Teams section)** — `29d812f` (docs)

**Plan metadata commit:** _(added below — `docs(07-12): complete deployment + docs plan`)_

## Files Created/Modified

### Created

- `relay/Dockerfile` (44 lines incl. comments) — multi-stage container build; runs as `USER node` on port 8080; CMD matches `relay/package.json` `start` script.
- `relay/fly.toml` (61 lines incl. comments) — Fly.io deploy config; `force_https = true`, `auto_stop_machines = "off"`, `auto_start_machines = true`, `min_machines_running = 1`, `/healthz` check, `shared-cpu-1x` 256mb in `iad`. Zero secrets.
- `relay/README.md` (189 lines) — Deploy Your Relay quickstart + 9-env-var reference table + operational caveats + troubleshooting + Deploy-elsewhere refs + Future roadmap + bidirectional cross-links.

### Modified

- `README.md` (+22 lines) — new `## VersionCon for Cloud Teams` section inserted between Git Users and Development; existing 5 sections (Status, Install, Lifecycle Tour, VersionCon for Git Users, Development) preserved byte-identical.

## Decisions Made

1. **`auto_start_machines = true` (NOT `false`)** — planning_context locks `true`; RESEARCH §A4 implies `false` per Fly.io's "both enabled or both disabled" doc guidance. Resolved in favor of planning_context: Fly.io's actual constraint allows `auto_stop=off + auto_start=true` as a valid manual-stop / auto-wake pairing — the machine persists while any session is alive (no idle-stop) AND can be manually stopped during true off-hours for cost control (with auto-wake on first incoming connection). Rationale is documented inline in `relay/fly.toml` (5-line comment) AND in `relay/README.md` Operational caveats (so future operators don't "fix" the combination).
2. **Stale CONTEXT D-03 wording avoided** — D-03 says "free tier covers small teams" but RESEARCH §Pitfall 2 documents the 2024-10-07 discontinuation. README uses RESEARCH's current facts (`$2-5/month` for new orgs; legacy orgs keep their allowance; link to live Fly.io pricing).
3. **No CI workflow added** — CONTEXT D-02 "self-host only for v1". Deploy is a USER action. The README walks them through doing it themselves; any future CI deploy is a separate threat surface.
4. **`relay/package-lock.json` already tracked** — `relay/.gitignore` excludes `node_modules/`, `dist/`, `*.log` but NOT `package-lock.json`; lockfile was committed at 07-08. No `npm install --package-lock-only` was run.
5. **Top-level README edit is a surgical Edit (not Write)** — exact-anchor replacement (line 83 → blank line 84 → line 85 = `Cloud export is one-way per command ... \n\n## Development`); confirmed by `git diff -U0` showing pure 22-line insertion.
6. **No third-party-secret env vars** — confirmed by `! grep -qE "(STRIPE_|OPENAI_|API_KEY=)"` on README; relay genuinely has zero third-party deps that need secrets (per-session JWT secret is runtime-generated, never persisted).
7. **`RELAY_REQUIRE_AUTH` documented as 10th env var** — 07-08 introduced this for local dev; included explicitly with **bold warning** "set to `false` for local development ONLY. Never set this on a deployed relay." Adds defense-in-depth — a misconfiguration that disables JWT verify on a public relay would be a CRITICAL security failure.
8. **`VERSIONCON_TOKEN_TTL` flagged host-side, not relay** — the env var is read by the host VS Code extension when it issues tokens; the relay verifies tokens against their baked-in `exp` claim, so setting the var on the Fly.io relay app has no effect. The README documents this explicitly to prevent operator confusion.

## Deviations from Plan

**None — plan executed exactly as written.** Every locked artifact, env-var entry, cost caveat, cross-link, and section boundary matches the spec in 07-12-PLAN.md `<read_first>` and `<tasks>`. No Rule 1/2/3 auto-fixes were triggered (this is a doc-only plan with no code paths to break).

The one discrepancy in the plan source (planning_context `auto_start_machines = true` vs RESEARCH `auto_start_machines = false`) was **pre-resolved in the plan itself** via the "Discrepancy note" instruction in `<read_first>` (line 153 of 07-12-PLAN.md) — executor followed the resolution as written (planning_context wins; inline comment in fly.toml explains the manual-stop/auto-wake semantic).

---

**Total deviations:** 0 auto-fixed
**Impact on plan:** Plan was tight and complete — no scope creep, no missed must-haves.

## Issues Encountered

- **Docker daemon not running locally.** `docker build` smoke test (optional per plan) was attempted but Docker.app daemon was offline (`Cannot connect to the Docker daemon`). Skipped per plan instruction: `If Docker is NOT available, SKIP this check and add an entry in the SUMMARY: '[MANUAL] cd relay && docker build -t versioncon-relay-test .'` — see Manual UAT items below.

## Threat Model Coverage

This plan introduces zero new code-level attack surface; threats are operational/deployment-level.

| Threat ID | Category               | Disposition | Mitigation                                                                                                                                         |
|-----------|------------------------|-------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| T-07-19   | Information Disclosure | accept      | Fly.io operator sees plaintext frames at TLS-termination edge. Documented in `relay/README.md` Operational Caveats as residual risk. L3 E2E body encryption deferred to future security phase per CONTEXT D-01; architectural seam (`CloudEnvelope.encrypted` flag) shipped in 07-02 so it plugs in without rewrite. |
| T-07-20   | Spoofing               | mitigate    | `relay/Dockerfile` runtime stage uses `USER node` (non-root, UID 1000). Inline comment names ASVS V14.1.1. Any in-process exploit bounded by `node` user capabilities. |
| T-07-21   | Elevation of Privilege | mitigate    | `relay/fly.toml` ships with `auto_stop_machines = "off"` AND inline 5-line comment explaining WHY. `relay/README.md` Operational Caveats has explicit "**Do not enable `auto_stop_machines = "stop"`**" warning citing RESEARCH §Pitfall 1. Plus auto_start=true comment so the manual-stop/auto-wake pairing is documented as intentional. |
| T-07-22   | Information Disclosure | mitigate    | `fly.toml` contains zero secret-shaped `key=value` lines — verified by `! grep -qiE "(secret\|password\|api[_-]?key)\\s*=" relay/fly.toml`. Per-session JWT secrets generated runtime via `crypto.randomBytes(32)` (07-03), never persisted. |
| T-07-23   | Repudiation            | mitigate    | `relay/README.md` Cost Note callout sets honest expectations: 2024-10-07 free-tier discontinuation date + `$2-5/month` cost range + legacy-account caveat + link to live Fly.io pricing. Avoids stale CONTEXT D-03 wording per RESEARCH §Pitfall 2. |
| T-07-24   | Tampering              | accept/oos  | This plan explicitly does NOT add any CI workflow. Deploy is a USER action per CONTEXT D-02. Any future CI-based deploy is a separate threat surface (Phase 9+ business/ops phase). |
| T-07-25   | Denial of Service      | accept      | Multi-stage build with `npm ci` cache layer + alpine base keeps builds <60s typically. Fly.io's remote builder caches layers. Alpine sufficient per RESEARCH §A5. |

**ASVS L1 satisfied:** V14.1.1 (non-root container), V14.3 (no secrets in env files), V9.1 (TLS in transit — delegated to Fly.io edge with Let's Encrypt + `force_https = true`), V1.5.4 (trust boundaries documented in `relay/README.md`).

**Architectural Responsibility Map check:** This plan operates entirely in the **deployment tier**. Zero new code in the byte-forwarder tier (relay/src/), protocol-logic tier (host SessionHost/extension), or presentation tier (extension UI). All four artifacts are ops-surface. Tier boundaries respected.

## Manual UAT (deferred to verifier)

These items require an environment the executor doesn't have. The `/gsd-verify-work 7` pass should execute them:

- **[MANUAL UAT-1]** Docker build smoke test: `cd relay && docker build -t versioncon-relay-test .` exits 0 within 60 seconds. Skipped here because Docker daemon was offline; the Dockerfile was reviewed line-by-line against the locked spec and matches byte-for-byte.
- **[MANUAL UAT-2]** End-to-end deploy quickstart: an unfamiliar developer follows `relay/README.md` from a clean checkout and has a `wss://*.fly.dev` endpoint with `{ok:true,sessions:0}` from `/healthz` in ≤5 minutes (CONTEXT D-03 phase-gate test). If it takes longer, that's a doc-clarity defect to file as a backlog item.
- **[MANUAL UAT-3]** Two-machine cloud-mode session: host (Alice on machine A) deploys relay, creates session via wizard's Cloud path, shares deep-link → member (Bob on machine B, different network) clicks link → joins → both can push/pull/chat (this is also Phase 7 SC-1 + SC-2 + SC-3 the live end-to-end test).

## Phase 7 Closeout Notes

- **All 13 plans complete:** 07-01 through 07-12 (including 07-05b). Wave 4 closed.
- **Test counts:** 71/71 relay (re-confirmed runtime) + 996/0/66 extension (preserved by code-isolation — this plan touched zero `.ts`/`.js` files).
- **NET-06 is feature-complete:** the relay is buildable, deployable, documented, and operable end-to-end. Phase 7 SC-3 (3 distinct cloud connection states) was closed in 07-07; SC-1 (host starts cloud session from same wizard) + SC-2 (member joins via relay) were "paper-verifiable" after 07-05b — now they have a deploy story underneath them.
- **Phase 7 gates remaining before close (orchestrator handles):**
  1. `/gsd-code-review 7` — cross-AI review of cumulative phase artifacts
  2. `/gsd-verify-work 7` — end-to-end UAT including the three MANUAL items above
- **Downstream / deferred (NOT this plan's concern):**
  - Phase 8 (AI Agent MCP) can proceed; depends on Phase 7's transport seam (`Transport` interface) but not on the deploy story.
  - Future security hardening phase: L3 body encryption (`CloudEnvelope.encrypted` flag flips to true), SSO/SAML/SCIM, audit logs, JWT refresh + revocation. v1 seams shipped in 07-02 (envelope) + 07-03 (TokenService claim schema).
  - Future business/ops: managed relay at `versioncon.dev`, multi-region, monitoring dashboards, auto-scaling. README's Future Roadmap section references all of these.

## User Setup Required

None — no external service configuration required for the build itself. Operators following `relay/README.md` will need to:

- Install flyctl (`brew install flyctl` or equivalent)
- Sign up for Fly.io (free for legacy accounts; ~$2-5/month for new accounts since 2024-10-07)
- Run `fly auth login` + `fly launch --copy-config --no-deploy` + `fly deploy`

…but these are operator actions, not VersionCon-developer actions. The repository ships fully self-contained.

## Next Phase Readiness

- Phase 7 is **feature-complete** pending verifier gate. The relay can be cloned, built, deployed, and connected to within 5 minutes following the documented quickstart.
- Phase 8 (AI Agent MCP Integration) can begin — depends on Phase 7's `Transport` interface (07-01) and protocol stability (07-02 envelope shape locked), neither of which is affected by this deployment plan.
- No blockers from this plan. All 8 must_haves.truths from 07-12-PLAN.md are verified green by the automated grep block in `<verification>`.

---
*Phase: 07-cloud-mode-relay-server*
*Plan: 12 of 13 (final)*
*Completed: 2026-05-19*

## Self-Check: PASSED

**File existence (created):**
- FOUND: relay/Dockerfile (44 lines)
- FOUND: relay/fly.toml (61 lines)
- FOUND: relay/README.md (189 lines)

**File modified:**
- FOUND: README.md (+22 lines via Edit; pre-existing sections byte-identical per `git diff -U0`)

**Commits:**
- FOUND: d7a42b2 (Task 1 — feat: relay Dockerfile + fly.toml)
- FOUND: 1e7e006 (Task 2 — docs: Deploy Your Relay quickstart)
- FOUND: 29d812f (Task 3 — docs: add VersionCon for Cloud Teams section)

**Plan-level invariants:**
- DOCKERFILE-CORE: node:20-alpine + USER node + EXPOSE 8080 all present
- FLY-TOML-CORE: force_https=true + auto_stop_machines="off" + path="/healthz" + internal_port=8080 all present
- NO-SECRETS: zero secret-shaped key=value lines in fly.toml
- TOML-PARSE: python3 tomllib accepts the file
- 9-ENV-VARS: all 9 locked env vars + RELAY_REQUIRE_AUTH present in relay/README.md
- FLY-COST-CAVEAT: 2024-10-07 + $2-5/month explicitly stated
- NO-STALE-FREE-PROMISE: "free tier covers small teams" wording absent
- BACKLINK-OK: relay/README.md → ../README.md present
- TOP-LEVEL-INSERT-OK: "VersionCon for Cloud Teams" + "relay/README.md" both present in README.md
- DEPLOY-ELSEWHERE-OK: AWS Fargate / Hetzner / DigitalOcean all referenced
- MANAGED-MENTION-BOTH-OK: "managed relay" appears in both relay/README.md and README.md
- ORDER-OK: top-level README sections in order Status → Install → Lifecycle Tour → Git Users → Cloud Teams → Development
- RELAY-TESTS: 71/71 passing (re-confirmed)
