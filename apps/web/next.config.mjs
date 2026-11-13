import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  poweredByHeader: false,
  // Operator CLIs run from the standalone image and import these directly, so they must be traced, not bundled.
  serverExternalPackages: ['zod', 'pg', '@node-rs/argon2'],
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Cache-Control', value: 'no-store' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
      ],
    }];
  },
};
