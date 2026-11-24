FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server server
COPY web web
RUN node --no-warnings server/index.mjs selftest
ENV HOST=0.0.0.0 DB_PATH=/data/hub.db
EXPOSE 4200
CMD ["node", "--no-warnings", "server/index.mjs"]
