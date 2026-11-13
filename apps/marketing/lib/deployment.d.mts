type Deployment = { basePath: string; url: string; source: string | null };
export function resolveDeployment(env: Record<string, string | undefined>): Deployment;
export const deployment: Deployment;
