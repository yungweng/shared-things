FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/common/package.json packages/common/
COPY packages/server/package.json packages/server/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter @shared-things/common... --filter shared-things-server...

# Copy source and build
COPY packages/common/ packages/common/
COPY packages/server/ packages/server/

RUN pnpm --filter @shared-things/common build && pnpm --filter shared-things-server build

# --- Runtime ---
FROM node:20-alpine

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/common/package.json packages/common/
COPY --from=builder /app/packages/common/dist packages/common/dist/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/packages/server/dist packages/server/dist/

RUN pnpm install --frozen-lockfile --prod --filter shared-things-server...

ENV DATA_DIR=/data
EXPOSE 3334

VOLUME /data

CMD ["node", "packages/server/dist/cli.js", "start", "--port", "3334"]
