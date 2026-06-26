/**
 * Registry of supported open-source, non-LLM security scanners.
 *
 * Each entry describes:
 *   - id:        short stable id used in --scanners and reports
 *   - name:      human label
 *   - kind:      sast | secrets | sca | iac  (what category of check)
 *   - bin:       the executable name to look for on PATH
 *   - detect:    args to run for a version/availability probe (fast, no scan)
 *   - install:   one-line install hint shown when the tool is missing
 *   - languages: short note on coverage (for the report/help)
 *   - license:   upstream license (informational)
 *
 * The actual command construction + output parsing lives in runners.js, keyed
 * by id. This separation keeps "what exists" (here) apart from "how to run and
 * parse it" (runners.js).
 *
 * NOTE: These are independent third-party tools with their own licenses. This
 * project does NOT bundle or redistribute them — it calls whatever you have
 * installed on PATH (BYOT: bring your own tools), exactly like BYOK for AI keys.
 */

export const SCANNERS = {
  semgrep: {
    id: 'semgrep',
    name: 'Semgrep',
    kind: 'sast',
    bin: 'semgrep',
    detect: ['--version'],
    install: 'pip install semgrep   (or: brew install semgrep)',
    languages: '30+ languages (JS/TS, Python, Java, Go, Ruby, PHP, C#, …)',
    license: 'LGPL-2.1',
    primary: true,
  },
  bandit: {
    id: 'bandit',
    name: 'Bandit',
    kind: 'sast',
    bin: 'bandit',
    detect: ['--version'],
    install: 'pip install bandit',
    languages: 'Python only',
    license: 'Apache-2.0',
  },
  gosec: {
    id: 'gosec',
    name: 'gosec',
    kind: 'sast',
    bin: 'gosec',
    detect: ['--version'],
    install: 'go install github.com/securego/gosec/v2/cmd/gosec@latest',
    languages: 'Go only',
    license: 'Apache-2.0',
  },
  gitleaks: {
    id: 'gitleaks',
    name: 'Gitleaks',
    kind: 'secrets',
    bin: 'gitleaks',
    detect: ['version'],
    install: 'brew install gitleaks   (or download from github.com/gitleaks/gitleaks/releases)',
    languages: 'Secrets in any file / git history',
    license: 'MIT',
  },
  trivy: {
    id: 'trivy',
    name: 'Trivy',
    kind: 'sca',
    bin: 'trivy',
    detect: ['--version'],
    install: 'brew install trivy   (or see github.com/aquasecurity/trivy)',
    languages: 'Dependencies (SCA) + IaC + secrets, filesystem scan',
    license: 'Apache-2.0',
  },
  'osv-scanner': {
    id: 'osv-scanner',
    name: 'OSV-Scanner',
    kind: 'sca',
    bin: 'osv-scanner',
    detect: ['--version'],
    install: 'go install github.com/google/osv-scanner/cmd/osv-scanner@latest   (or download a release binary)',
    languages: 'Dependency CVEs from lockfiles (npm, pip, go, maven, …)',
    license: 'Apache-2.0',
  },
  checkov: {
    id: 'checkov',
    name: 'Checkov',
    kind: 'iac',
    bin: 'checkov',
    detect: ['--version'],
    install: 'pip install checkov',
    languages: 'IaC: Terraform, CloudFormation, Kubernetes, Helm, ARM, Dockerfile',
    license: 'Apache-2.0',
  },
};

/** Default scanner set (the well-rounded "production" stack). */
export const DEFAULT_SCANNERS = [
  'semgrep', 'bandit', 'gosec', 'gitleaks', 'trivy', 'osv-scanner', 'checkov',
];

export const SCANNER_KINDS = {
  sast: 'Static code analysis (SAST)',
  secrets: 'Secret / credential detection',
  sca: 'Dependency vulnerabilities (SCA)',
  iac: 'Infrastructure-as-Code misconfig',
};

export function listScanners() {
  return Object.values(SCANNERS);
}

export function resolveScanners(names) {
  if (!names || !names.length) return DEFAULT_SCANNERS.map((id) => SCANNERS[id]);
  const out = [];
  for (const n of names) {
    const id = String(n).trim().toLowerCase();
    if (SCANNERS[id]) out.push(SCANNERS[id]);
    else out.push({ id, name: id, kind: 'sast', bin: id, detect: ['--version'], install: `(unknown tool "${id}")`, unknown: true });
  }
  return out;
}
