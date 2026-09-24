# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub's **Report a
vulnerability** button on the repository's *Security* tab. Please do not
open a public issue for security problems.

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
- The `openfpga.toolchain.*` settings have `machine` scope (user or remote
  settings only), so a workspace (e.g. a cloned repo) cannot point the
  extension at an arbitrary executable.
- The **Project Settings panel** (a webview) runs under a strict Content
  Security Policy: no remote content, only its own nonce-tagged script and
  stylesheet. Every message from the page is validated before use: project
  and module names are checked, and file paths must stay inside the
  project.
- The extension declares `untrustedWorkspaces.supported: false` and stays
  inactive until the workspace is trusted.
- Network activity is limited to the toolchain download and the GitHub
  release API.
