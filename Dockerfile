FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node config ./config

USER node
EXPOSE 8080 9000
CMD ["node", "src/gateway.js"]
