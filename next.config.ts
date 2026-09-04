import type { NextConfig } from 'next';

const config: NextConfig = {
  // Standalone bundles only the files the server actually needs, which is what
  // keeps the deployed image close to Node plus Chromium rather than the whole
  // node_modules tree.
  output: 'standalone',
  // Playwright must load from the Node runtime rather than be bundled: it
  // spawns a browser binary, which no bundler can trace.
  serverExternalPackages: ['playwright'],
  experimental: {
    // bigint values cross the server/client boundary on every quote line.
    serverActions: { bodySizeLimit: '4mb' },
  },
};

export default config;
