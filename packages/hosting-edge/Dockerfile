# syntax=docker/dockerfile:1
#
# The EDGE FORWARDER image, `registry.fly.io/motir-hosting-edge` (MOTIR-10127),
# run as the `motir-edge` Fly app: the home of every customer domain's
# certificate. For each request it asks Motir's host contract what the domain
# serves and either forwards the request to that application or answers one of
# its own four pages. See `src/server.ts`.
#
# Dependency-free: Node's own `http`, `https`, `tls` and `crypto`, and Node's
# type stripping (unflagged since 22.18) runs the TypeScript source as it is, so
# there is no build stage and nothing to install. The build context is THIS
# directory (`.github/workflows/hosting-edge-image.yml`).

FROM node:22-alpine

LABEL org.opencontainers.image.title="motir-hosting-edge" \
      org.opencontainers.image.description="Forwards a customer domain to the application it names, or answers the edge's own page." \
      org.opencontainers.image.source="https://github.com/motir-co/motir-core"

ENV NODE_ENV=production
WORKDIR /edge
COPY package.json ./
COPY src ./src

# The image's own non-root user; the edge writes nothing.
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
