# syntax=docker/dockerfile:1

FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Flat node_modules for the image only, so the outputFileTracingIncludes glob in
# next.config.ts resolves against real directories instead of pnpm's symlinks
# into .pnpm. Local development keeps pnpm's default linker.
RUN pnpm install --frozen-lockfile --node-linker=hoisted

FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The Prisma client is generated into a git-ignored, docker-ignored directory,
# so it never exists in the build context. Without this the build cannot
# typecheck lib/db.ts.
#
# prisma.config.ts resolves DATABASE_URL eagerly and `generate` refuses to run
# without it, even though generating a client never opens a connection. The
# placeholder satisfies that check at build time; the real URL is injected at
# runtime. Deliberately not a build arg — nothing here should be able to reach
# a real database.
RUN DATABASE_URL=postgresql://generate:generate@127.0.0.1:5432/generate \
    pnpm prisma generate
RUN pnpm build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Never run the server as root.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs
# `output: standalone` emits a self-contained server, so no node_modules here.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
