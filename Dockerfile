FROM node:22-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.32.1
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN pnpm test && pnpm build && pnpm test:readonly && pnpm prune --prod

FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chmod=644 --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules/
COPY --from=build /app/dist ./dist/
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN mkdir -p /data && chmod 700 /data && chown node:node /data
ENTRYPOINT ["docker-entrypoint"]
CMD ["node", "dist/index.js"]
