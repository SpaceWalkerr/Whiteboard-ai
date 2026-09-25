# apps/server image for docker-compose.scale.yml (local scale and load tests only).
# Render builds the service natively from render.yaml; this image is not deployed.
# Build context: the repository root (see .dockerignore).
FROM node:22.20-slim
ENV HUSKY=0 CI=1
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @whiteboard/server build
EXPOSE 4000
# Migrations run from the same image (docker-compose.scale.yml's "migrate" service).
CMD ["node", "--enable-source-maps", "apps/server/dist/index.js"]
