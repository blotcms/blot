# syntax=docker/dockerfile:1
FROM node:24.22.1-alpine
WORKDIR /opt/agentation
COPY package.json package-lock.json ./
# SQLite may need a native build on platforms without a prebuilt binary.
# The optional CA secret supports managed development environments.
RUN --mount=type=secret,id=proxy_ca \
    set -eu; \
    cp /etc/ssl/certs/ca-certificates.crt /tmp/original-ca.crt; \
    if [ -f /run/secrets/proxy_ca ]; then \
      cat /run/secrets/proxy_ca >> /etc/ssl/certs/ca-certificates.crt; \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    fi; \
    apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --no-audit --no-fund \
    && apk del .build-deps \
    && mv /tmp/original-ca.crt /etc/ssl/certs/ca-certificates.crt
COPY browser.jsx build.mjs http-server.mjs ./
RUN npm run build
ENV AGENTATION_HOST=0.0.0.0 AGENTATION_STORE=sqlite AGENTATION_CORS_ORIGINS=""
VOLUME /root/.agentation
CMD ["node", "http-server.mjs"]
