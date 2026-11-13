export function resolveDeployment(env) {
  const basePath = env.NEXT_PUBLIC_BASE_PATH || '';
  if (basePath && !/^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(basePath)) {
    throw new Error('Use an empty Pages base path or a leading slash with no trailing slash.');
  }
  const origin = new URL(env.SITE_ORIGIN || 'http://localhost:3000');
  if (!['https:', 'http:'].includes(origin.protocol) || origin.href !== origin.origin + '/') {
    throw new Error('SITE_ORIGIN must be an HTTP(S) origin.');
  }
  const repository = env.TALLYMED_REPOSITORY || '';
  if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('Set TALLYMED_REPOSITORY to OWNER/REPO.');
  }
  return {
    basePath,
    url: origin.origin + basePath,
    source: repository ? 'https://github.com/' + repository : null,
  };
}
export const deployment = resolveDeployment(process.env);
