// Refuses to install dependencies in an environment that weakens supply-chain safety.
const problems = [];

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  problems.push(
    'NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate checks: packages could be swapped in transit. Unset it first.',
  );
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  problems.push(
    `Node ${process.versions.node} detected; Jarvis requires Node 24 LTS (see .nvmrc).`,
  );
}

if (problems.length > 0) {
  for (const p of problems) console.error(`✖ ${p}`);
  process.exit(1);
}
