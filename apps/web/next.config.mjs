import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  poweredByHeader: false,
};
