import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle so the runtime image needs no
  // node_modules. See Dockerfile.
  output: 'standalone',

  // Next's own require-hook resolves `@swc/helpers/esm/*` at runtime through
  // that package's exports map. File tracing does not see those subpaths and
  // copies only its package.json, so the standalone server dies on startup
  // with MODULE_NOT_FOUND. Force the whole package into the trace.
  outputFileTracingIncludes: {
    '/**/*': ['./node_modules/@swc/helpers/**'],
  },
};

export default nextConfig;
