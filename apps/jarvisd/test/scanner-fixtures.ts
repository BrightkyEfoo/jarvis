import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScannerId } from '../src/security/catalogue.ts';
import type { Locate } from '../src/security/run.ts';

/** Fake secrets. The token matches the redactor's GitHub pattern; the key matches none. */
export const FAKE_TOKEN = 'ghp_FAKE0123456789abcdefghijklmnopqrstuv';
export const FAKE_KEY = 'Zq8vR2pL9xW4mK7tQ';

/**
 * A fake scanner: records its argv and environment, answers `--version`, then prints the
 * fixture (`__ROOT__` replaced by its last argument) and exits with the configured code.
 * Mode "hang" never answers (timeout tests). A fixture `{ "__byArg": { k: doc } }` picks the
 * document whose key appears in argv (checkov for CI vs IaC).
 */
const SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const self = process.argv[1];
const tool = path.basename(self);
const dir = path.join(path.dirname(self), '.state');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, tool + '.args'), JSON.stringify(args) + '\\n');
fs.writeFileSync(path.join(dir, tool + '.env'), JSON.stringify(process.env));
const read = (ext) => { try { return fs.readFileSync(path.join(dir, tool + ext), 'utf8'); } catch { return ''; } };
if (args[0] === '--version' || args[0] === 'version') {
  process.stdout.write(tool + ' version 1.2.3\\n');
  process.exit(0);
}
if (read('.mode').trim() === 'hang') {
  setInterval(() => {}, 1000);
} else {
  const last = args[args.length - 1] || '';
  let doc = JSON.parse(read('.json') || 'null');
  if (doc && doc.__byArg) {
    const key = Object.keys(doc.__byArg).find((k) => args.includes(k));
    doc = key ? doc.__byArg[key] : null;
  }
  process.stdout.write(JSON.stringify(doc).replaceAll('__ROOT__', last));
  process.stderr.write(read('.stderr') || 'scanning\\n');
  process.exitCode = Number(read('.exit') || 0);
}
`;

export interface FakeScanners {
  dir: string;
  locate: Locate;
  install(tool: ScannerId, doc: unknown, o?: { exit?: number; stderr?: string }): string;
  hang(tool: ScannerId): void;
  /** Every argv the fake received, in order. */
  calls(tool: ScannerId): string[][];
  env(tool: ScannerId): Record<string, string> | null;
  cleanup(): void;
}

export function fakeScanners(binDir?: string): FakeScanners {
  const dir = binDir ?? realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-scanners-')));
  const state = join(dir, '.state');
  mkdirSync(state, { recursive: true });
  const installed = new Map<ScannerId, string>();
  return {
    dir,
    locate: (id) => installed.get(id) ?? null,
    install(tool, doc, o = {}) {
      const bin = join(dir, tool);
      writeFileSync(bin, `#!${process.execPath}\n${SCRIPT}`);
      chmodSync(bin, 0o755);
      writeFileSync(join(state, `${tool}.json`), JSON.stringify(doc));
      writeFileSync(join(state, `${tool}.exit`), String(o.exit ?? 0));
      if (o.stderr !== undefined) writeFileSync(join(state, `${tool}.stderr`), o.stderr);
      rmSync(join(state, `${tool}.mode`), { force: true });
      installed.set(tool, bin);
      return bin;
    },
    hang(tool) {
      writeFileSync(join(state, `${tool}.mode`), 'hang');
    },
    calls(tool) {
      const p = join(state, `${tool}.args`);
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]);
    },
    env(tool) {
      const p = join(state, `${tool}.env`);
      return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>) : null;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A small project with CI, IaC, a lockfile and a hardcoded token. */
export function makeProject(root: string): string {
  const files: Record<string, string> = {
    'package.json': '{"name":"app","dependencies":{"lodash":"4.17.20"}}\n',
    'package-lock.json': '{"lockfileVersion":3,"packages":{"node_modules/lodash":{}}}\n',
    'src/config.ts': `export const token = "${FAKE_TOKEN}";\n`,
    '.github/workflows/ci.yml':
      'on: issues\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
    'infra/main.tf': 'resource "aws_s3_bucket" "data" {\n  acl = "public-read"\n}\n',
    Dockerfile: 'FROM node:24\nCOPY . .\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

/**
 * gitleaks as if it had ignored --redact (adversarial): raw Secret, Match and Line, and a
 * description that repeats the key. Nothing of it may reach the summary.
 */
export const GITLEAKS_RAW = [
  {
    RuleID: 'github-pat',
    Description:
      'Uncovered a GitHub Personal Access Token, potentially leading to unauthorized repository access.',
    StartLine: 1,
    EndLine: 1,
    StartColumn: 22,
    EndColumn: 61,
    Match: `token = "${FAKE_TOKEN}"`,
    Secret: FAKE_TOKEN,
    File: '__ROOT__/src/config.ts',
    SymlinkFile: '',
    Commit: '',
    Line: `export const token = "${FAKE_TOKEN}";`,
    Entropy: 4.9,
    Author: '',
    Email: '',
    Date: '',
    Message: '',
    Tags: [],
    Fingerprint: '__ROOT__/src/config.ts:github-pat:1',
  },
  {
    RuleID: 'generic-api-key',
    Description: `Detected a Generic API Key ${FAKE_KEY}, potentially exposing access to various services.`,
    StartLine: 4,
    EndLine: 4,
    StartColumn: 1,
    EndColumn: 30,
    Match: `API_KEY: ${FAKE_KEY}`,
    Secret: FAKE_KEY,
    File: `__ROOT__/deploy/values-${FAKE_KEY}.yaml`,
    Line: `API_KEY: ${FAKE_KEY}`,
    Entropy: 3.9,
    Tags: [],
    Fingerprint: `__ROOT__/deploy/values.yaml:generic-api-key:4`,
  },
];

/** gitleaks with --redact, as documented. */
export const GITLEAKS_REDACTED = [
  {
    ...GITLEAKS_RAW[0],
    Match: 'token = "REDACTED"',
    Secret: 'REDACTED',
    Line: 'export const token = "REDACTED";',
  },
];

export const OSV = {
  results: [
    {
      source: { path: '__ROOT__/package-lock.json', type: 'lockfile' },
      packages: [
        {
          package: { name: 'lodash', version: '4.17.20', ecosystem: 'npm' },
          vulnerabilities: [
            {
              id: 'GHSA-35jh-r3h4-6jhm',
              aliases: ['CVE-2021-23337'],
              summary: 'Command Injection in lodash',
              affected: [
                {
                  package: { ecosystem: 'npm', name: 'lodash' },
                  ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
                },
              ],
              database_specific: { severity: 'HIGH' },
            },
          ],
          groups: [
            {
              ids: ['GHSA-35jh-r3h4-6jhm'],
              aliases: ['CVE-2021-23337', 'GHSA-35jh-r3h4-6jhm'],
              max_severity: '7.2',
              experimentalAnalysis: { 'GHSA-35jh-r3h4-6jhm': { called: true, unimportant: false } },
            },
          ],
        },
        {
          package: { name: 'minimist', version: '1.2.0', ecosystem: 'npm' },
          dependency_groups: ['dev'],
          vulnerabilities: [
            {
              id: 'GHSA-xvch-5gv4-984h',
              aliases: ['CVE-2021-44906'],
              summary: 'Prototype Pollution in minimist',
              affected: [
                {
                  package: { ecosystem: 'npm', name: 'minimist' },
                  ranges: [
                    { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.2.4' }] },
                    { type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '1.2.6' }] },
                  ],
                },
              ],
            },
          ],
          groups: [{ ids: ['GHSA-xvch-5gv4-984h'], max_severity: '9.8' }],
        },
        {
          package: { name: 'golang.org/x/net', version: '0.7.0', ecosystem: 'Go' },
          vulnerabilities: [
            {
              id: 'GO-2023-1988',
              aliases: ['CVE-2023-3978', 'GHSA-2wrh-6pvc-2jm9'],
              summary: 'Improper rendering of text nodes in golang.org/x/net/html',
              affected: [
                {
                  package: { ecosystem: 'Go', name: 'golang.org/x/net' },
                  ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.13.0' }] }],
                },
              ],
            },
          ],
          groups: [
            {
              ids: ['GO-2023-1988'],
              max_severity: '6.1',
              experimentalAnalysis: { 'GO-2023-1988': { called: false, unimportant: false } },
            },
          ],
        },
      ],
    },
  ],
};

const zizmorLoc = (row: number, annotation: string) => ({
  symbolic: {
    key: { Local: { prefix: '__ROOT__', given_path: '__ROOT__/.github/workflows/ci.yml' } },
    annotation,
    route: { route: [] },
    feature_kind: 'Normal',
    kind: 'Primary',
  },
  concrete: {
    location: {
      start_point: { row, column: 8 },
      end_point: { row, column: 60 },
      offset_span: { start: 100, end: 160 },
    },
    // A GitHub Actions expression (not a JS template), as zizmor quotes it.
    feature: ['run: echo "$', '{{ github.event.issue.title }}"'].join(''),
    comments: [],
  },
});

export const ZIZMOR = [
  {
    ident: 'template-injection',
    desc: 'code injection via template expansion',
    url: 'https://docs.zizmor.sh/audits/#template-injection',
    determinations: { confidence: 'High', severity: 'High', persona: 'Regular' },
    locations: [zizmorLoc(14, 'may expand into attacker-controllable code')],
    ignored: false,
  },
  {
    ident: 'unpinned-uses',
    desc: 'unpinned action reference',
    url: 'https://docs.zizmor.sh/audits/#unpinned-uses',
    determinations: { confidence: 'High', severity: 'Medium', persona: 'Regular' },
    locations: [zizmorLoc(5, 'action is not pinned to a hash (required by blanket policy)')],
    ignored: false,
  },
  {
    ident: 'artipacked',
    desc: 'credential persistence through GitHub Actions artifacts',
    url: 'https://docs.zizmor.sh/audits/#artipacked',
    determinations: { confidence: 'Low', severity: 'Medium', persona: 'Regular' },
    locations: [zizmorLoc(5, 'does not set persist-credentials: false')],
    ignored: true,
  },
];

const failed = (id: string, name: string, file: string, line: number, resource: string) => ({
  check_id: id,
  bc_check_id: null,
  check_name: name,
  check_result: { result: 'FAILED', evaluated_keys: [] },
  code_block: [[line, `secret code ${FAKE_KEY}`]],
  file_path: file,
  file_abs_path: `__ROOT__${file}`,
  repo_file_path: file,
  file_line_range: [line, line + 3],
  resource,
  evaluations: null,
  check_class: 'checkov.terraform.checks',
  fixed_definition: null,
  entity_tags: null,
  caller_file_path: null,
  caller_file_line_range: null,
  resource_address: null,
  severity: null,
  bc_category: null,
  benchmarks: null,
  description: null,
  short_description: null,
  vulnerability_details: null,
  connected_node: null,
  guideline: `https://docs.prismacloud.io/en/policy-reference/${id.toLowerCase()}`,
  details: [],
  check_len: null,
});

const summary = { passed: 3, failed: 2, skipped: 0, parsing_errors: 0, resource_count: 2 };

export const CHECKOV_IAC = [
  {
    check_type: 'terraform',
    results: {
      passed_checks: [],
      failed_checks: [
        failed(
          'CKV_AWS_20',
          'S3 Bucket has an ACL defined which allows public READ access.',
          '/infra/main.tf',
          1,
          'aws_s3_bucket.data',
        ),
        failed(
          'CKV_AWS_18',
          'Ensure the S3 bucket has access logging enabled',
          '/infra/main.tf',
          1,
          'aws_s3_bucket.data',
        ),
      ],
      skipped_checks: [],
      parsing_errors: [],
    },
    summary: { ...summary, checkov_version: '3.2.470' },
  },
  {
    check_type: 'dockerfile',
    results: {
      passed_checks: [],
      failed_checks: [
        failed(
          'CKV_DOCKER_3',
          'Ensure that a user for the container has been created',
          '/Dockerfile',
          1,
          '/Dockerfile.',
        ),
      ],
      skipped_checks: [],
      parsing_errors: [],
    },
    summary: { ...summary, checkov_version: '3.2.470' },
  },
];

export const CHECKOV_GITLAB = {
  check_type: 'gitlab_ci',
  results: {
    passed_checks: [],
    failed_checks: [
      failed(
        'CKV_GITLABCI_1',
        'Suspicious use of curl with CI environment variables in script',
        '/.gitlab-ci.yml',
        5,
        'deploy',
      ),
    ],
    skipped_checks: [],
    parsing_errors: [],
  },
  summary: { ...summary, checkov_version: '3.2.470' },
};

/** What checkov prints when no file of the requested frameworks exists. */
export const CHECKOV_EMPTY = {
  passed: 0,
  failed: 0,
  skipped: 0,
  parsing_errors: 0,
  resource_count: 0,
  checkov_version: '3.2.470',
};

export const TRIVY_IMAGE = {
  SchemaVersion: 2,
  ArtifactName: 'acme/api:1.4',
  ArtifactType: 'container_image',
  Results: [
    {
      Target: 'acme/api:1.4 (debian 12.5)',
      Class: 'os-pkgs',
      Type: 'debian',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2024-6387',
          PkgName: 'openssh-client',
          InstalledVersion: '1:9.2p1-2+deb12u2',
          FixedVersion: '1:9.2p1-2+deb12u3',
          Status: 'fixed',
          Severity: 'HIGH',
          Title: "openssh: regreSSHion: RCE in OpenSSH's server",
          PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2024-6387',
        },
        {
          VulnerabilityID: 'CVE-2023-45853',
          PkgName: 'zlib1g',
          InstalledVersion: '1:1.2.13.dfsg-1',
          Status: 'will_not_fix',
          Severity: 'CRITICAL',
          Title: 'zlib: integer overflow in zipOpenNewFileInZip4_6',
        },
      ],
    },
  ],
};

export const TRIVY_CONFIG = {
  SchemaVersion: 2,
  ArtifactName: '__ROOT__',
  ArtifactType: 'filesystem',
  Results: [
    {
      Target: 'infra/main.tf',
      Class: 'config',
      Type: 'terraform',
      MisconfSummary: { Successes: 4, Failures: 1 },
      Misconfigurations: [
        {
          Type: 'Terraform Security Check',
          ID: 'AWS-0092',
          AVDID: 'AVD-AWS-0092',
          Title: 'S3 Buckets not publicly accessible through ACL.',
          Message: 'Bucket has a public ACL: "public-read".',
          Resolution: "Don't use canned ACLs or switch to private acl",
          Severity: 'HIGH',
          Status: 'FAIL',
          CauseMetadata: { Resource: 'aws_s3_bucket.data', StartLine: 2, EndLine: 2 },
        },
        {
          ID: 'AWS-0089',
          Title: 'Bucket has logging disabled',
          Severity: 'MEDIUM',
          Status: 'PASS',
        },
      ],
    },
  ],
};

export const GRYPE = {
  matches: [
    {
      vulnerability: {
        id: 'CVE-2021-44228',
        dataSource: 'https://nvd.nist.gov/vuln/detail/CVE-2021-44228',
        namespace: 'github:language:java',
        severity: 'Critical',
        fix: { versions: ['2.15.0'], state: 'fixed' },
        knownExploited: [{ cve: 'CVE-2021-44228', knownRansomwareCampaignUse: 'Known' }],
        epss: [{ cve: 'CVE-2021-44228', epss: 0.97, percentile: 1 }],
      },
      artifact: {
        name: 'log4j-core',
        version: '2.14.1',
        type: 'java-archive',
        locations: [{ path: '/app/lib/log4j-core-2.14.1.jar', layerID: 'sha256:abc' }],
      },
    },
    {
      vulnerability: {
        id: 'CVE-2023-0001',
        severity: 'Medium',
        fix: { versions: [], state: 'not-fixed' },
      },
      artifact: { name: 'libfoo', version: '1.0', type: 'deb', locations: [] },
    },
  ],
};

export const SEMGREP = {
  version: '1.95.0',
  results: [
    {
      check_id: 'rules.js.eval-injection',
      path: '__ROOT__/src/server.js',
      start: { line: 12, col: 3, offset: 200 },
      end: { line: 12, col: 30, offset: 227 },
      extra: {
        message: 'eval() with user input: code injection',
        severity: 'ERROR',
        metadata: {},
        lines: `  eval(req.query.code) // ${FAKE_KEY}`,
        fingerprint: 'requires login',
        engine_kind: 'OSS',
      },
    },
  ],
  errors: [],
};
