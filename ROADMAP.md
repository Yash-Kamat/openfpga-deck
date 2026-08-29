# Roadmap

OpenFPGA Deck orchestrates the open-source FPGA toolchain (YosysHQ OSS CAD
Suite) inside VS Code: write HDL → synthesize → place & route → pack a
bitstream → program the board.

Development is incremental. Each phase is small, lands as its own commit, and
is verified against a real Sipeed Tang Nano 20K where hardware is involved.

**v0.1 goal — the vertical slice:**

```
Open an FPGA project
  → Build   (Yosys → nextpnr-himbaechel → gowin_pack)
  → Program (openFPGALoader)
  → Tang Nano 20K
```

First target board: Sipeed Tang Nano 20K (Gowin GW2AR-LV18QN88C8/I7).
Primary platform: Linux x64. Other platforms follow as OSS CAD Suite supports
them — untested platforms are never claimed as supported.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Extension scaffold | Done |
| 2 | `fpga.yaml` project configuration | Done |
| 3a | Toolchain discovery & validation | Done |
| 3b | Managed toolchain download | Done |
| 4a | Board definition registry | Done |
| 4b | "Initialize Project" wizard | Done |
| 5 | Synthesis (Yosys) | In progress |
| 6 | Place & route (nextpnr-himbaechel) | Planned |
| 7 | Bitstream packing (gowin_pack) | Planned |
| 8 | Programming (openFPGALoader) | Planned |
| 9 | Diagnostics (tool logs → editor) | Planned |
| 10 | Test suite | Ongoing |
| 11 | CI (GitHub Actions) | Planned |
| 12 | Documentation | Planned |
| 13 | VSIX packaging | Planned |
| 14 | Marketplace publishing | Planned |

## v0.1 phases

### 1 — Extension scaffold — Done

Minimal activatable extension: command registration, a shared output channel,
the compile/lint/package pipeline.

### 2 — Project configuration — Done

`fpga.yaml` schema (`name`, `board`, `top`, `sources`, `constraints`); a
loader/validator with clear, located error messages; source/constraint paths
must be relative and stay inside the project; the `Validate Project` command.

### 3a — Toolchain discovery — Done

Locate an existing OSS CAD Suite from the `openfpga.toolchain.path` setting,
`PATH`, or conventional locations; confirm `yosys`, `nextpnr-himbaechel`,
`gowin_pack`, and `openFPGALoader` are present and read their versions.
`Verify Toolchain` / `Select Toolchain` commands and a status-bar indicator.

### 3b — Managed toolchain download — Done

`Download Toolchain`: fetch a release (latest via the GitHub API, or a
specific tag) from the official repo, integrity-check it (GitHub's asset
digest → a hash recorded from a previous download → confirmed
trust-on-first-use), extract it safely, and offer to make it active.
Releases coexist under `<installDir>/oss-cad-suite-<tag>/`; archives are kept
in `downloads/` and reused when their hash matches.

### 4a — Board definition registry — Done

Declarative board files (`boards/gowin/tang-nano-20k.yaml`): FPGA part,
family, package and pin list, default constraints, programmer parameters. A
loader/validator and a registry the rest of the pipeline reads — no hardcoded
per-board branching. A reusable `.cst` parse/serialize module lands here too
(needed by the wizard and, later, the IO planner).

### 4b — "Initialize Project" wizard — Done

A guided QuickPick sequence for an empty folder: project name → board → top
module → scaffold `fpga.yaml`, `src/top.sv`, `constraints/top.cst`, and
`build/`. The richer configuration panel is a v0.2 item (below).

### 5 — Synthesis (Yosys) — In progress

Run `yosys` with `synth_gowin` (family from the board definition) over the
project sources to produce a JSON netlist. Introduces the build orchestrator:
subprocesses spawned with argument arrays, output streamed to the channel,
cancellable, a single-build lock, and a predictable `build/` layout
(`yosys/ pnr/ bitstream/ logs/ reports/`).

### 6 — Place & route — Planned

Run `nextpnr-himbaechel` with the device string, `--vopt family=…`, and the
`.cst` constraints to produce a placed-and-routed netlist. The per-family
argument model is first-class (Gowin/Himbaechel first).

### 7 — Bitstream packing — Planned

Run `gowin_pack` to produce the `.fs` bitstream. Surface a resource-usage
report to the user.

### 8 — Programming (openFPGALoader) — Planned

`Program` and `Build and Program`: `openFPGALoader -b tangnano20k` for SRAM
or `-f` for SPI flash, with the board flag from the board definition. USB
device detection.

### 9 — Diagnostics — Planned

Best-effort regex parsing of Yosys and nextpnr logs into `vscode.Diagnostic`s
anchored to the right source lines. Not a full parser.

### 10 — Test suite — Ongoing

Unit tests already grow with each phase (`src/test/unit/`, the Node test
runner). This phase formalizes coverage and adds integration tests that need
no hardware.

### 11 — CI — Planned

GitHub Actions: compile, lint, test, and package on Linux; a platform matrix
as support lands.

### 12 — Documentation — Planned

README, `CONTRIBUTING`, `SECURITY`, and `docs/` (the toolchain integrity
model, the publishing process). An example-project walkthrough.

### 13 — VSIX packaging — Planned

Decide bundling (esbuild vs unbundled), finalize `.vscodeignore`, review
dependencies, check the shipped size.

### 14 — Marketplace publishing — Planned

Publisher setup and `vsce publish`. PAT authentication initially; the Entra
ID / managed-identity path is documented as the intended successor (Azure
DevOps retires global PATs on 2026-12-01).

## Security posture (every phase)

- Orchestrates existing tools; never reimplements or bundles them.
- Every subprocess is spawned with an executable + argument array — never a
  shell string.
- Toolchain downloads only from
  `github.com/YosysHQ/oss-cad-suite-build/releases/`, over HTTPS, and are
  integrity-checked.
- Archive extraction refuses absolute paths and `..` segments.
- `openfpga.toolchain.*` settings are `machine-overridable`, so a workspace
  (e.g. a cloned repo) cannot point the extension at an arbitrary executable.
- No telemetry, no analytics, and no network requests beyond the toolchain
  download and the GitHub release API.

## v0.2 and beyond

- **Uninstall Toolchain** — remove a managed release folder and/or its
  archive from a picker, with a guard against removing the active one.
- **Check for Toolchain Updates** — compare the active release against the
  latest and offer to fetch it.
- **Init wizard — configuration panel** — an ESP-IDF-style webview: board and
  FPGA part, detected USB ports, toolchain version selection (existing path
  vs automated download), invalid options greyed out, "restore defaults" and
  "save" actions that scaffold the project. Built on the finished
  board/toolchain/programmer subsystems.
- **Visual IO planner** — a package/pin grid; assign top-level ports to
  physical pins by drag-and-drop; round-trips the board's `.cst`. Pin data
  from Project Apicula's device databases. No open-source equivalent exists;
  `nextpnr`'s Qt GUI floorplan view is the reference for rendering the
  fabric.
- **Floorplanner** — placement-region constraints for P&R. Lower priority.
- **Simulation** — Verilator / Icarus Verilog / GTKWave / Surfer integration.
- **More platforms** — Windows, macOS (Intel and Apple Silicon), Linux
  ARM64.
- **More boards and families** — further Gowin boards, then iCE40 (`icepack`)
  and ECP5 (`ecppack`) flows.
