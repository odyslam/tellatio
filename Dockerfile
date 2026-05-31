FROM node:22-slim

RUN npm install -g pnpm@9

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json ./
COPY bin/ ./bin/
COPY src/ ./src/

RUN pnpm build

# Create data directory for sync state, owned by the non-root runtime user
RUN mkdir -p /data && chown -R node:node /data

# Drop privileges for the runtime (build steps above run as root)
USER node

CMD ["node", "dist/index.js"]
