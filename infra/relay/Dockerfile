# The relay, containerised (DEPLOY.1). Build context is the REPO ROOT:
#
#   docker build -f infra/relay/Dockerfile -t confit-relay .
#
# Two stages, because the runtime needs no dependencies at all. The CLI and the relay
# import nothing outside node builtins — the only bare specifier anywhere in the compiled
# output is `vitest`, and that appears solely in test files, which are deleted below. So
# the runtime layer is node plus `dist/`, with no node_modules to audit or patch.

# ---------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /build

# Dependencies first, so a source-only change does not re-run npm ci.
COPY package.json package-lock.json ./
RUN npm ci

# vitest.config.ts is not optional here even though the relay never runs a test: tsconfig
# includes `*.config.ts` and `src/index.test.ts` imports it, so `tsc` — and therefore
# `npm run build`, and therefore `fly deploy` — fails without it:
#   src/index.test.ts(6,60): error TS2307: Cannot find module '../vitest.config.js'
COPY tsconfig.json vitest.config.ts vite.config.ts tailwind.config.ts postcss.config.js* index.html* ./
COPY src ./src
COPY infra ./infra
COPY scripts ./scripts
COPY data ./data
COPY tests ./tests

RUN npm run build

# Tests are the only thing that would drag vitest into the runtime image, and a demo
# relay has no business shipping them.
RUN find dist -name '*.test.js' -delete -o -name '*.test.d.ts' -delete

# ---------------------------------------------------------------- runtime
FROM node:22-alpine AS runtime
WORKDIR /app

# The store of record's snapshot lives here. Mount a named volume over it — see
# docker-compose.yml. Losing this directory loses every confession, permanently.
RUN mkdir -p /var/lib/confit && chown node:node /var/lib/confit

COPY --from=build --chown=node:node /build/dist ./dist
COPY infra/relay/entrypoint.sh /usr/local/bin/relay-entrypoint.sh
RUN chmod +x /usr/local/bin/relay-entrypoint.sh

ENV NODE_ENV=production \
    RELAY_PORT=8787 \
    RELAY_DUMP_PATH=/var/lib/confit/relay.json

# No `USER node` here, deliberately: the entrypoint starts as root to chown the mounted
# volume and then execs the relay as `node` (busybox `su`), so the relay itself still runs
# unprivileged — `ps` inside the container shows `1 node node dist/infra/relay/main.js`.
# Setting the image user instead would make the chown impossible and the fly volume
# unwritable. tests/guards/relayImageBuild.test.ts keeps it that way.

# No curl or wget in the image, and no reason to add them: node is already here. `/stats`
# is the open, coarse view (P0.9) so the healthcheck needs no token. fly ignores Docker
# HEALTHCHECK — [checks.stats] in fly.toml is the same probe for the fly path.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8787)+'/stats').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No EXPOSE and no published ports: with the Tailscale sidecar in compose this process
# shares the tailnet namespace and is reachable only from the tailnet. On fly there is no
# [http_service] and no public IP. That is the whole security posture — the relay is never
# on the public internet.
ENTRYPOINT ["/usr/local/bin/relay-entrypoint.sh"]
CMD ["node", "dist/infra/relay/main.js"]
