FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /work
COPY . .
RUN corepack enable \
  && corepack prepare pnpm@11.25.0 --activate \
  && pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm prune --prod

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /work/dist ./dist
COPY --from=build --chown=node:node /work/node_modules ./node_modules
COPY --from=build --chown=node:node /work/package.json ./package.json
USER node
CMD ["node", "dist/apps/worker/src/index.js"]
