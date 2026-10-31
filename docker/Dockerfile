# Keeta Checkout, as a container.
#
# Two stages. The builder needs a C toolchain because `secp256k1`, which Keeta's
# client uses for its default key algorithm, compiles native bindings. The runtime
# stage carries none of that.
#
# Build from the repository root:
#   docker build -f docker/Dockerfile -t keeta-checkout .
#
# Run it:
#   docker run --rm -p 3000:3000 \
#     -v keeta-checkout-data:/data \
#     --env-file .env \
#     keeta-checkout

# ---------- builder ----------
FROM node:24-bookworm-slim AS builder

# node-gyp needs python3, make and a compiler for the native secp256k1 bindings.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# The manifests first, so a dependency install is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/server/package.json ./packages/server/
COPY packages/button/package.json ./packages/button/
COPY packages/cli/package.json ./packages/cli/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/refunds/package.json ./packages/refunds/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Drop everything the runtime does not need, including every devDependency.
RUN pnpm prune --prod

# ---------- runtime ----------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
# A container must listen on every interface, not just loopback.
ENV HOST=0.0.0.0
ENV PORT=3000
# The database belongs on a volume, not in the image layer.
ENV KEETA_CHECKOUT_DATABASE=/data/keeta-checkout.sqlite

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages ./packages

# `node` is the unprivileged user the official image already ships.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 3000

# The server holds no signing key, so a compromise of this container cannot move
# the merchant's funds. It needs only the public receiving address.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Exec form, so the process is PID 1 and receives SIGTERM directly. The server
# drains the watcher and the webhook queue before exiting.
ENTRYPOINT ["node", "packages/cli/bin/keeta-checkout.js"]
CMD ["serve"]
