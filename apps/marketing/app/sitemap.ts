import type { MetadataRoute } from 'next';
import { absoluteUrl } from '../lib/site';

export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  return [absoluteUrl('/'), absoluteUrl('/roadmap/')].map((url) => ({ url }));
}
