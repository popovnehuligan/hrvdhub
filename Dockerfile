FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=3000

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME /app/data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "src/index.js"]
