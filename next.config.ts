import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle so the runtime image needs no
  // node_modules. See Dockerfile.
  output: 'standalone',
};

export default nextConfig;
