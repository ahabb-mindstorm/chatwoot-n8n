FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY factory ./factory
COPY runtime ./runtime
COPY workflows ./workflows
COPY migrations ./migrations

CMD ["node", "factory/server.mjs"]
