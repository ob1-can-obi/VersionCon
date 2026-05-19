# syntax=docker/dockerfile:1
#
# VersionCon Relay — multi-stage build.
#
# Build stage: install all deps, compile TypeScript via `npm run build`
#   (07-08 ships the `build` script in relay/package.json → `tsc`).
# Runtime stage: install production deps only (--omit=dev), copy compiled
#   dist/ from the build stage, run as the non-root `node` user.
#
# Why USER node? Defense-in-depth. Any in-process exploit is bounded by
# the `node` user's capabilities — no root-owned filesystem writes, no
# privileged syscalls. ASVS V14.1.1 (container runs as non-root).
#
# Why node:20-alpine? Small attack surface (musl + busybox base), faster
# pulls on Fly.io's edge, and matches `engines.node` in relay/package.json.
#
# Why npm ci (not npm install)? Reproducible builds — requires
# package-lock.json to be checked in. The relay/.gitignore does NOT
# exclude package-lock.json (lockfile MUST be committed for reproducible
# Docker builds; see RESEARCH §Pitfall 3 and relay/README.md).
#
# See relay/README.md for end-to-end deploy instructions (Fly.io is the
# recommended target; the same image runs on AWS Fargate, Hetzner Cloud,
# DigitalOcean App Platform, or any Docker-capable platform).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
