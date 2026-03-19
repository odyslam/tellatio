FROM node:22-slim

RUN npm install -g pnpm@9

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm build

# Create data directory for sync state
RUN mkdir -p /data

CMD ["node", "dist/index.js"]
