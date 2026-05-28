# syntax=docker/dockerfile:1.7
FROM node:24-alpine

RUN apk add --no-cache tini

WORKDIR /app

# Deps layer (cached by package-lock.json)
COPY package.json package-lock.json ./
RUN npm ci

# App source + frontend build
COPY . .
RUN npm run build

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
