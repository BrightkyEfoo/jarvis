/**
 * The fixed catalogue of scanners and of the exact argv Jarvis may run with them. Nothing else is
 * ever executed: no shell, no flag or argument coming from the model except the scanned folder
 * (already resolved and checked) and a validated image reference.
 *
 * Flags were checked against each tool's documentation, not against a real binary (none is
 * installed on the dev Mac yet). If a release renames a flag, adjust it here and nowhere else.
 */

export const SCANNERS = [
  'gitleaks',
  'osv-scanner',
  'zizmor',
  'checkov',
  'trivy',
  'grype',
  'syft',
  'opengrep',
  'semgrep',
] as const;
export type ScannerId = (typeof SCANNERS)[number];

export const CHECKS = ['secrets', 'dependencies', 'ci', 'iac', 'image', 'sast'] as const;
export type CheckId = (typeof CHECKS)[number];

/** Image needs an explicit reference; SAST silently skips without a local ruleset. */
export const DEFAULT_CHECKS: readonly CheckId[] = ['secrets', 'dependencies', 'ci', 'iac', 'sast'];

export const CHECK_FR: Record<CheckId, string> = {
  secrets: 'secrets',
  dependencies: 'dépendances',
  ci: 'CI',
  iac: 'IaC',
  image: 'image',
  sast: 'SAST',
};

export interface ScannerInfo {
  role: string;
  /** Install hint shown to Brightky. Jarvis never installs anything itself. */
  install: string;
  /** Approximate download (bottle and dependencies, plus databases where relevant). */
  size: string;
  sizeMb: number;
  /** Installed through Homebrew (grouped in the "install everything" line). */
  brew: boolean;
  versionArgs: readonly string[];
}

export const SCANNER_INFO: Record<ScannerId, ScannerInfo> = {
  gitleaks: {
    role: 'secrets dans les fichiers',
    install: 'brew install gitleaks',
    size: '~8 Mo',
    sizeMb: 8,
    brew: true,
    versionArgs: ['version'],
  },
  'osv-scanner': {
    role: 'CVE des dépendances (lockfiles)',
    install: 'brew install osv-scanner',
    size: '~15 Mo',
    sizeMb: 15,
    brew: true,
    versionArgs: ['--version'],
  },
  zizmor: {
    role: 'sécurité des GitHub Actions',
    install: 'brew install zizmor',
    size: '~6 Mo',
    sizeMb: 6,
    brew: true,
    versionArgs: ['--version'],
  },
  checkov: {
    role: 'IaC (Terraform, Kubernetes, Dockerfile…) et CI GitLab',
    install: 'brew install checkov',
    size: '~100 Mo avec Python, sur Wi-Fi',
    sizeMb: 100,
    brew: true,
    versionArgs: ['--version'],
  },
  trivy: {
    role: 'CVE des images (IaC en secours)',
    install: 'brew install trivy',
    size: '~45 Mo, puis ~70 Mo de base au premier scan, sur Wi-Fi',
    sizeMb: 115,
    brew: true,
    versionArgs: ['--version'],
  },
  grype: {
    role: 'CVE des images',
    install: 'brew install grype',
    size: '~25 Mo, puis ~60 Mo de base au premier scan',
    sizeMb: 85,
    brew: true,
    versionArgs: ['version'],
  },
  syft: {
    role: 'SBOM (avec grype)',
    install: 'brew install syft',
    size: '~25 Mo',
    sizeMb: 25,
    brew: true,
    versionArgs: ['version'],
  },
  opengrep: {
    role: 'SAST avec des règles locales',
    install:
      'binaire de github.com/opengrep/opengrep/releases (vérifier l’empreinte ; jamais curl | sh)',
    size: '~45 Mo',
    sizeMb: 45,
    brew: false,
    versionArgs: ['--version'],
  },
  semgrep: {
    role: 'SAST avec des règles locales (si pas d’opengrep)',
    install: 'brew install semgrep',
    size: '~150 Mo avec Python, sur Wi-Fi',
    sizeMb: 150,
    brew: true,
    versionArgs: ['--version'],
  },
};

/**
 * Releases known to be malicious (TeamPCP supply-chain attack on Trivy, March 2026:
 * GHSA-69fq-xp46-6x23). Flagged by security_tools; the last safe release cited is 0.69.3.
 */
export const COMPROMISED: Partial<Record<ScannerId, readonly string[]>> = {
  trivy: ['0.69.4', '0.69.5', '0.69.6'],
};

/** Checkov frameworks for the iac check: no secrets (gitleaks does it), no SCA (needs an API
 * key), no helm/kustomize (they can fetch remote charts and bases). */
export const IAC_FRAMEWORKS = [
  'terraform',
  'cloudformation',
  'kubernetes',
  'dockerfile',
  'serverless',
  'arm',
  'bicep',
  'ansible',
] as const;

/** The argv of every invocation, flags first then the target (urfave/cli stops at the first
 * positional argument). */
export const ARGV = {
  gitleaks: (root: string) => [
    'dir',
    '--report-format',
    'json',
    '--report-path',
    '-',
    '--redact',
    '--no-banner',
    root,
  ],
  osvScanner: (root: string, offline: boolean) => [
    'scan',
    'source',
    '--recursive',
    '--format',
    'json',
    ...(offline ? ['--offline'] : []),
    root,
  ],
  // --offline: no GitHub API call (no token is ever given anyway).
  zizmor: (root: string) => ['--format', 'json', '--offline', root],
  // --skip-download: nothing sent to or fetched from Prisma Cloud.
  checkov: (root: string, frameworks: readonly string[]) => [
    '--directory',
    root,
    '--framework',
    ...frameworks,
    '--output',
    'json',
    '--compact',
    '--quiet',
    '--skip-download',
  ],
  trivyConfig: (root: string, offline: boolean) => [
    'config',
    '--format',
    'json',
    '--quiet',
    ...(offline ? ['--skip-check-update'] : []),
    root,
  ],
  trivyImage: (ref: string, offline: boolean) => [
    'image',
    '--format',
    'json',
    '--quiet',
    '--scanners',
    'vuln',
    ...(offline ? ['--skip-db-update', '--skip-java-db-update', '--offline-scan'] : []),
    '--',
    ref,
  ],
  grypeImage: (ref: string) => ['--output', 'json', '--quiet', '--', ref],
  opengrep: (rules: string, root: string) => ['scan', '--config', rules, '--json', '--quiet', root],
  semgrep: (rules: string, root: string) => [
    'scan',
    '--config',
    rules,
    '--json',
    '--quiet',
    '--metrics',
    'off',
    '--disable-version-check',
    root,
  ],
} as const;

/** Exit codes that mean "ran, here is the report" (findings or not). */
export const OK_CODES: Record<ScannerId, readonly number[]> = {
  gitleaks: [0, 1], // 1 = leaks found
  'osv-scanner': [0, 1], // 1 = vulnerabilities found; 128 = no package found
  zizmor: [0, 10, 11, 12, 13, 14], // 10 + highest severity
  checkov: [0, 1], // 1 = failed checks
  trivy: [0],
  grype: [0],
  syft: [0],
  opengrep: [0, 1],
  semgrep: [0, 1],
};

/** Exit codes that mean "nothing to scan here". */
export const EMPTY_CODES: Partial<Record<ScannerId, readonly number[]>> = {
  'osv-scanner': [128],
};

/** Local rulesets accepted for SAST, inside the project. Never `--config auto` (network). */
export const SAST_RULESETS = [
  '.opengrep.yml',
  '.opengrep.yaml',
  '.opengrep',
  '.semgrep.yml',
  '.semgrep.yaml',
  '.semgrep',
] as const;

/** Schemes grype (and some others) read as "scan this local path or file": refused. */
export const IMAGE_SCHEMES =
  /^(docker|podman|docker-archive|oci-archive|oci-dir|singularity|dir|file|registry|sbom|containerd|purl|cpe|tar|archive):/i;

/** name[:tag][@sha256:digest], optional registry host[:port]/. No leading dash, no spaces. */
export const IMAGE_REF =
  /^(?:[a-z0-9][a-z0-9.-]*(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::\w[\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
