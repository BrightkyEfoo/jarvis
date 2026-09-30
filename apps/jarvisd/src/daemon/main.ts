import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { SEALED_POLICY_PATH } from '@jarvis/policy';
import { KeychainStore } from '@jarvis/secrets';
import { environmentProblems } from '../guards.ts';
import { appPaths } from '../paths.ts';
import { createRuntime } from './runtime.ts';
import { startServer } from './server.ts';

const DEV_POLICY = resolve(import.meta.dirname, '../../../../config/policy.example.yaml');

export async function runDaemon(opts: { dev: boolean }): Promise<void> {
  const problems = environmentProblems();
  if (problems.length > 0) {
    for (const p of problems) console.error(`✖ ${p}`);
    process.exitCode = 1;
    return;
  }
  process.umask(0o077);
  const t0 = performance.now();
  const paths = appPaths();
  const rt = createRuntime({
    paths,
    home: homedir(),
    policyPath: opts.dev ? DEV_POLICY : SEALED_POLICY_PATH,
    secrets: new KeychainStore(),
    devMode: opts.dev,
  });
  const server = await startServer(rt, paths.socket);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(
    `jarvisd ready in ${ms} ms — policy ${rt.policy.sha256.slice(0, 12)}${opts.dev ? ' (DEV: unsealed, N3 disabled)' : ' (sealed)'}`,
  );
  if (rt.killswitch.engaged)
    console.log(`⏹ STOP is engaged: ${rt.killswitch.reason} — \`jarvis resume\` to restart`);
  if (!rt.brain)
    console.log('⚠ no subscription token: `jarvis auth set-token` then restart the daemon');

  // Warm the model process in the background so the first question has no cold start.
  rt.brain?.warm().then(
    () => console.log(`model process warm after ${(performance.now() - t0).toFixed(0)} ms`),
    (e: Error) => console.error(`✖ model warm-up failed: ${e.message}`),
  );

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    await rt.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
