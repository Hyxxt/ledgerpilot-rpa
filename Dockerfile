# 用 Playwright 官方镜像：Chromium 和它的全部系统依赖都已经在里面，
# 用普通 node 镜像还得自己补 libnss3 / libatk 那一堆，容易在部署时才崩。
ARG PLAYWRIGHT_VERSION=1.65.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PORT=10000 \
    LEDGER_HOST=0.0.0.0 \
    LEDGER_DATA=/tmp/ledgerpilot-data \
    PLAYWRIGHT_BUNDLED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    AUTO_SEED=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 10000
CMD ["node", "server.mjs"]
