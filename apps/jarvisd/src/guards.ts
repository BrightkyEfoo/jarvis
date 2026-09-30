/** Startup checks. Each returns a list of problems; the daemon refuses to start on any. */

export function environmentProblems(
  env: NodeJS.ProcessEnv = process.env,
  nodeVersion = process.versions.node,
): string[] {
  const problems: string[] = [];
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    problems.push(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification for every request Jarvis makes',
    );
  }
  if (Number(nodeVersion.split('.')[0]) < 24)
    problems.push(`Node ${nodeVersion}: Node 24 LTS required`);
  return problems;
}

/** Credential sources that would bill the Anthropic API instead of the Claude subscription. */
const BILLED_KEY_SOURCES = new Set([
  'ANTHROPIC_API_KEY',
  'apiKeyHelper',
  '/login managed key',
  'user',
  'project',
  'org',
  'temporary',
]);

export interface AuthFacts {
  apiKeySource?: string | undefined;
  apiProvider?: string | undefined;
  subscriptionType?: string | undefined;
  tokenSource?: string | undefined;
}

/** Zero cost beyond the subscription: refuse anything that is not claude.ai OAuth. */
export function subscriptionProblems(a: AuthFacts): string[] {
  const problems: string[] = [];
  if (a.apiKeySource && BILLED_KEY_SOURCES.has(a.apiKeySource)) {
    problems.push(`requests would be billed to an API key (source: ${a.apiKeySource})`);
  }
  if (a.apiProvider && a.apiProvider !== 'firstParty') {
    problems.push(`provider ${a.apiProvider} is not the Claude subscription`);
  }
  return problems;
}

export const TOOL_PREFIX = 'mcp__jarvis__';

/** The model must see our tools and nothing else. */
export function surfaceProblems(
  tools: readonly string[],
  mcpServers: readonly { name: string; source?: string }[],
): string[] {
  const problems: string[] = [];
  const foreign = tools.filter((t) => !t.startsWith(TOOL_PREFIX));
  if (foreign.length > 0)
    problems.push(`unexpected tools exposed to the model: ${foreign.join(', ')}`);
  const servers = mcpServers.filter(
    (s) => s.name !== 'jarvis' || (s.source !== undefined && s.source !== 'sdk'),
  );
  if (servers.length > 0)
    problems.push(`unexpected MCP servers: ${servers.map((s) => s.name).join(', ')}`);
  return problems;
}
