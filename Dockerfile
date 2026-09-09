FROM node:24.18.0-bookworm-slim AS build
# Build-time apt mirror override (defaults to upstream; no behavior change unless set):
#   docker build --build-arg APT_MIRROR=mirrors.tuna.tsinghua.edu.cn .
ARG APT_MIRROR=deb.debian.org
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG SOURCE_DIR=.
COPY ${SOURCE_DIR}/package.json ${SOURCE_DIR}/package-lock.json ./
RUN npm ci
COPY ${SOURCE_DIR}/tsconfig.json ./
COPY ${SOURCE_DIR}/src ./src
COPY ${SOURCE_DIR}/scripts/build.mjs ./scripts/build.mjs
RUN npm run build && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8088 MEMORY_MODE=offline MEMORY_DATA_DIR=/data
WORKDIR /app
ARG SOURCE_DIR=.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY ${SOURCE_DIR}/package.json ./
COPY ${SOURCE_DIR}/contracts ./contracts
COPY ${SOURCE_DIR}/licenses ./licenses
COPY ${SOURCE_DIR}/README.md ${SOURCE_DIR}/INSTRUCTION.md ${SOURCE_DIR}/SDD.md ./
COPY ${SOURCE_DIR}/docs/CONFIGURATION.md ${SOURCE_DIR}/docs/VALIDATION.md ${SOURCE_DIR}/docs/DELIVERY-CHECKLIST.md ./docs/
COPY ${SOURCE_DIR}/configs ./configs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8088
HEALTHCHECK --interval=5s --timeout=8s --start-period=10s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8088)+'/health',{signal:AbortSignal.timeout(7000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","--env-file=configs/release-offline.env","dist/server.js"]
