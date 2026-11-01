# syntax=docker/dockerfile:1
#
# The HOSTING GUARD image, `registry.fly.io/motir-hosting-guard` (MOTIR-9947),
# to the decision of record MOTIR-5769 §4 (page cmvrcywwc00jkhpr1zvvnike8, v1).
#
# The Fly adapter of the hosting deploy port runs it as the first container of
# every release Machine, on the service's port 9180, in front of the app. It
# answers 403 to any request without the app's `X-Motir-Origin-Secret` and
# proxies the rest to the app on 127.0.0.1. See `src/guard.ts`.
#
# Dependency-free: Node's own `http`, `net` and `crypto`, and Node's type
# stripping (unflagged since 22.18) runs the TypeScript source as it is, so there
# is no build stage and nothing to install. The build context is THIS directory
# (`.github/workflows/hosting-guard-image.yml`).

FROM node:22-alpine

LABEL org.opencontainers.image.title="motir-hosting-guard" \
      org.opencontainers.image.description="Refuses any request without the app's origin secret; proxies the rest to the app." \
      org.opencontainers.image.source="https://github.com/motir-co/motir-core"

ENV NODE_ENV=production
WORKDIR /guard
COPY package.json ./
COPY src ./src

# The image's own non-root user; the guard writes nothing.
USER node
EXPOSE 9180
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
