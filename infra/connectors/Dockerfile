FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build

WORKDIR /work
COPY . .
RUN corepack enable \
  && corepack prepare pnpm@11.25.0 --activate \
  && pnpm install --frozen-lockfile \
  && pnpm build

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

ARG CONNECTOR_KIND
ENV ODA_CONNECTOR_KIND=${CONNECTOR_KIND}
LABEL org.opencontainers.image.title="O-D-A reference connector" \
  org.opencontainers.image.version="0.1.0-phase.1" \
  org.opencontainers.image.source="local://one-developer-army" \
  org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app
COPY --from=build /work/dist ./dist
COPY --from=build /work/node_modules ./node_modules
COPY infra/connectors/runtime.mjs ./runtime.mjs

USER node
ENTRYPOINT ["node", "/app/runtime.mjs"]
