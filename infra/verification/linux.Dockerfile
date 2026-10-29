FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

WORKDIR /work
COPY . .

RUN corepack enable \
  && corepack prepare pnpm@11.25.0 --activate \
  && pnpm install --frozen-lockfile \
  && pnpm build

CMD ["node", "tools/verify-linux-config.mjs"]
