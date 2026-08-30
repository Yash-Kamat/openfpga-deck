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
| 5 | Synthesis (Yosys) | Done |
| 6 | Place & route (nextpnr-himbaechel) | Done |
| 7 | Bitstream packing (gowin_pack) | Done |
| 8a | Programming (openFPGALoader) | Done |
| 8b | Flash backup & restore | Done |
| 9 | Docs + release metadata | Next |
| 10 | CI (GitHub Actions) | Planned |
| 11 | VSIX packaging | Planned |
| 12 | Marketplace publishing | Planned |

Everything past the working vertical slice that is not needed to *ship*
has moved to [v0.2 and beyond](#v02-and-beyond): log → Problems-panel
diagnostics, a formalised test/integration pass, esbuild bundling. The
priority is a published, working v0.1; polish follows.

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
module → language (Verilog default) → starter design → scaffold `fpga.yaml`,
`src/top.v`, `constraints/top.cst`, and `build/`. The richer configuration
panel is a v0.2 item (below).

### 5 — Synthesis (Yosys) — Done

Run `yosys` with `synth_gowin` over the project sources to produce a JSON
netlist, via a generated `build/yosys/synth.ys` script (one `read_verilog`
line per source, `-sv` only for `.sv`). Introduces the build engine:
subprocesses spawned with argument arrays, output streamed to the channel,
cancellable, a single-build lock, and a predictable `build/` layout
(`yosys/ pnr/ bitstream/ logs/ reports/`). Device/family targeting is
nextpnr's job (Phase 6), not yosys's.

### 6 — Place & route — Done

Run `nextpnr-himbaechel` with the device string, `--vopt family=…`, and the
`.cst` constraints to produce a placed-and-routed netlist. The per-family
argument model is first-class (Gowin/Himbaechel first).

### 7 — Bitstream packing — Done

Run `gowin_pack` to produce the `.fs` bitstream. Surface a resource-usage
report to the user.

### 8a — Programming (openFPGALoader) — Done

`Program` (a prompt for SRAM, volatile, or SPI flash, persistent — defaulting
to the board's target), `Build and Program` (the full slice), and
`Detect Board` (`openFPGALoader -b <board> --detect`, used as a preflight).
The board flag comes from the board definition. openFPGALoader's `\r`
progress bars are throttled in the output channel; permission / udev
failures get a pointer to the fix.

### 8b — Flash backup & restore — Done

Before any flash write, offer to dump the current flash contents
(`--dump-flash --file-size <programmer.flashSize>`) to
`build/backup/flash-<timestamp>.bin`, so an accidental overwrite of a
board's factory image is recoverable. Adds `programmer.flashSize` to the
board schema.

`Write File to Board` completes the loop: pick any `.fs` bitstream or
`.bin` flash image from anywhere on disk and write it to SRAM or flash —
used to restore a backup or flash a prebuilt bitstream. Flash writes go
through the same backup prompt.

The build actions also get a status-bar cluster (Build, Build and Program,
Detect Board, a "more" menu, and a Cancel button while a build runs);
progress moves to `ProgressLocation.Window` so the toast stops covering
the Output view.

### 9 — Docs + release metadata — Next

`README.md` (the Marketplace listing), `CHANGELOG.md`, `SECURITY.md`,
`CONTRIBUTING.md`, `docs/PUBLISHING.md`. `package.json` release fields:
`version` 0.1.0, `icon`, `repository`, curated `keywords`. An extension
icon.

### 10 — CI — Planned

GitHub Actions: compile, lint, test, and `vsce package` on Linux; a
platform matrix as support lands.

### 11 — VSIX packaging — Planned

Finalise `.vscodeignore`, review the shipped file list and size, produce
`openfpga-deck-0.1.0.vsix`. (esbuild bundling is a v0.2 item.)

### 12 — Marketplace publishing — Planned

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

### Build pipeline

- **Diagnostics** — best-effort regex parsing of Yosys and nextpnr logs into
  `vscode.Diagnostic`s anchored to the right source lines, in the Problems
  panel. Not a full parser. (Was a v0.1 phase; deferred to ship sooner.)
- **Formalised tests** — integration tests over the injected-IO flows and a
  coverage pass, beyond the per-module unit tests that grow with each phase.
- **esbuild bundling** — bundle to one file to shrink the VSIX and speed
  activation; v0.1 ships unbundled (one runtime dep, `yaml`) to keep
  debugging simple.
- **Incremental builds** — re-run a stage when its inputs changed, not only
  when its output file is missing. Today a stage command reuses an existing
  earlier-stage artefact even if the HDL or constraints have since changed;
  track source mtimes or hashes and rebuild what is stale.
- **Clean command** — remove the `build/` tree (or just its regenerable
  parts) from a command.
- **VHDL synthesis** — wire up the `ghdl` / ghdl-yosys-plugin path bundled in
  OSS CAD Suite so `.vhd` / `.vhdl` sources synthesise; they are currently
  rejected with a clear message.
- **Per-clock timing constraints** — richer than the single global `--freq`
  taken from the board's first clock today.

### Board & programming

- **Flash backup** — Phase 8b lands the backup-before-write prompt and
  `Write File to Board`; a later pass may keep a rotating set of dumps and a
  one-click "restore latest".
- **Programmer / cable selection** — when more than one board or FTDI cable
  is attached, let the user choose (`openFPGALoader --ftdi-serial` / `-c`)
  instead of assuming the first.
- **Serial monitor** — open the board's UART (the Tang Nano 20K exposes it as
  a second USB serial device) in a VS Code terminal at a configurable baud,
  so `printf`-style debugging and SoC consoles (e.g. the factory LiteX BIOS)
  work without an external `minicom`.

### Editor experience

- **Coloured build console** — render the pipeline output in a pseudoterminal
  (`window.createTerminal({ pty })`) with hand-written ANSI: dimmed stage
  rules, green / red result markers, tool output left as-is. VS Code's `log`
  output-channel grammar was tried and rejected — its generic lexer colours
  every number and identifier. Trade-off: moves the build log from the
  Output panel to the Terminal panel.
- **Init wizard — configuration panel** — an ESP-IDF-style webview: board and
  FPGA part, detected USB ports, toolchain version selection (existing path
  vs automated download), invalid options greyed out, "restore defaults" and
  "save" actions that scaffold the project. Built on the finished
  board / toolchain / programmer subsystems.
- **Visual IO planner** — a package/pin grid; assign top-level ports to
  physical pins by drag-and-drop; round-trips the board's `.cst`. Pin data
  from Project Apicula's device databases. No open-source equivalent exists;
  `nextpnr`'s Qt GUI floorplan view is the reference for rendering the
  fabric.
- **Floorplanner** — placement-region constraints for P&R. Lower priority.

### Toolchain

- **Uninstall Toolchain** — remove a managed release folder and/or its
  archive from a picker, with a guard against removing the active one.
- **Check for Toolchain Updates** — compare the active release against the
  latest and offer to fetch it.

### Reach

- **Simulation** — Verilator / Icarus Verilog / GTKWave / Surfer integration.
- **More platforms** — Windows, macOS (Intel and Apple Silicon), Linux
  ARM64.
- **More boards and families** — further Gowin boards, then iCE40 (`icepack`)
  and ECP5 (`ecppack`) flows.
