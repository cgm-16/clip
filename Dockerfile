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

# The Prisma CLI, isolated from the app's own dependency tree. `output:
# standalone` traces only what app code imports, so it never picks up the
# `prisma` package (only invoked from a script, never imported). Installing
# it here instead of in `deps` keeps devDependencies unrelated to migrating
# (eslint, vitest, tailwind, typescript, ...) out of every image entirely,
# app and migration alike. The pinned version must be bumped by hand
# alongside package.json's `prisma` devDependency; nothing enforces that.
FROM node:24-alpine AS migrate-deps
WORKDIR /migrate
RUN corepack enable
RUN echo '{"name":"clip-migrate","private":true,"dependencies":{"prisma":"7.9.1"}}' > package.json
# pnpm 10 blocks postinstall scripts unless a workspace file allows them, and
# @prisma/engines downloads its query engine binary in exactly such a script.
# The repo root grants this in pnpm-workspace.yaml; this stage installs outside
# that workspace, so it needs its own grant or the install fails outright.
RUN printf 'allowBuilds:\n  "@prisma/engines": true\n  prisma: true\n' > pnpm-workspace.yaml
RUN pnpm install --node-linker=hoisted

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Never run the server as root.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs
# `output: standalone` emits a self-contained server, so app code needs no
# node_modules of its own here — but the migration tooling copied in below
# still does.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Everything `prisma migrate deploy` needs at runtime: the CLI and its own
# dependency closure, the migrations to apply, the schema they were
# generated against, and the config file the CLI reads DATABASE_URL through.
# This is what lets the initContainer in k8s/deployment.yaml run migrations
# using this same image with a `command:` override instead of a second image.
# Kept at /migrate, NOT merged into /app/node_modules: `output: standalone`
# emits its own traced node_modules there, and copying a second tree over it
# would let the Prisma closure silently replace packages Next traced.
COPY --from=migrate-deps --chown=nextjs:nodejs /migrate/node_modules /migrate/node_modules
# Alongside the CLI, not under /app: prisma.config.ts does
# `import ... from 'prisma/config'`, which only resolves from a directory whose
# node_modules contains the prisma package. Running it from /app fails with
# "Cannot find module 'prisma/config'" -- verified, not assumed. The app itself
# never reads these; it reaches Postgres through the generated client.
COPY --from=builder --chown=nextjs:nodejs /app/prisma/schema.prisma /migrate/prisma/schema.prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma/migrations /migrate/prisma/migrations
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts /migrate/prisma.config.ts
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
