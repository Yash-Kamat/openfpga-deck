# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub's **Report a
vulnerability** button on the repository's *Security* tab, or by email to the
maintainer. Please do not open a public issue for security problems.

You'll get an acknowledgement within a few days. Once a fix is available it
will be released and the report credited unless you prefer otherwise.

## Security posture

OpenFPGA Deck runs external toolchain binaries and downloads software, so it
holds itself to a few firm rules:

- **No telemetry, no analytics, no data collection.** No source code,
  project names, designs or machine identifiers ever leave the machine.
- **Every subprocess** is spawned with an executable path and an argument
  array — never a shell string, never `shell: true`.
- **Toolchain downloads** come only from
  `github.com/YosysHQ/oss-cad-suite-build/releases/`, over HTTPS, and are
  integrity-checked (GitHub's published asset digest, a hash recorded from a
  previous download, or a confirmed trust-on-first-use prompt).
- **Archive extraction** refuses absolute paths and `..` segments.
- The `openfpga.toolchain.*` settings are `machine-overridable`, so a
  workspace (e.g. a cloned repo) cannot point the extension at an arbitrary
  executable.
- The extension declares `untrustedWorkspaces.supported: false` and stays
  inactive until the workspace is trusted.
- Network activity is limited to the toolchain download and the GitHub
  release API.
