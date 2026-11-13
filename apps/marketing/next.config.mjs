import { deployment } from './lib/deployment.mjs';

export default {
  output: 'export',
  trailingSlash: true,
  basePath: deployment.basePath,
  images: { unoptimized: true },
  devIndicators: false,
};
