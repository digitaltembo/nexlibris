# syntax=docker/dockerfile:1.7-labs

# The nexlibris server (M4) with the web app, as one image:
#
#   docker build -t nexlibris .
#
# or `docker compose up -d`. The server is bundled into one file
# (rolldown), so the image holds only Node, that file and the built web app. Options are the server's
# environment variables (`docker run --rm nexlibris --help`); data is kept in /data.

ARG NODE_VERSION=24

# The build makes only JavaScript, so it runs on the builder's own platform, whatever the image is for
# (linux/amd64 and linux/arm64 alike), rather than emulated.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build

# Dependencies first, from the workspaces' manifests alone, so they're cached while only code changes.
WORKDIR /src/nexlibris
COPY --parents package.json package-lock.json */package.json ./
# The desktop app is a workspace too, but Electron's binary isn't needed to build the server.
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w client && npm run build -w server

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
  NEXLIBRIS_DATA=/data \
  NEXLIBRIS_CLIENT=/app/client/dist \
  NEXLIBRIS_PORT=8080
WORKDIR /app
# The bundle is an ES module, which its package.json says.
COPY --from=build /src/nexlibris/server/package.json server/package.json
COPY --from=build /src/nexlibris/server/dist server/dist
COPY --from=build /src/nexlibris/client/dist client/dist
# Owned by the unprivileged user, so a named volume mounted there is too.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.NEXLIBRIS_PORT || 8080) + '/api/auth/session').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["node", "/app/server/dist/main.js"]
CMD ["serve"]
