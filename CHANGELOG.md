# Changelog

All notable changes to OpenFPGA Deck are documented here.

## 0.1.0 — 2026-08-30

First release: the complete open-source FPGA flow for the Sipeed Tang Nano
20K, verified end to end on real hardware.

### Added

- **Project system** — `fpga.yaml` schema, loader/validator with located
  error messages, `Validate Project`, and an **Initialize Project** wizard
  (name → board → top module → Verilog/SystemVerilog → starter design).
- **Board registry** — declarative board definitions (`boards/**/*.yaml`);
  the Tang Nano 20K ships in the box. A reusable Gowin `.cst` parser/writer.
- **Toolchain management** — discovery from `PATH` / common locations,
  `Verify Toolchain`, `Select Toolchain`, and **Download Toolchain** (fetches
  a release from the official GitHub repo, integrity-checks it via GitHub's
  asset digest or confirmed trust-on-first-use, keeps releases side by side).
- **Build pipeline** — `Synthesize` (Yosys), `Place and Route`
  (nextpnr-himbaechel, with a resource + Fmax report), `Pack Bitstream`
  (gowin_pack), and `Build` for the whole chain. Cancellable, single-build
  lock, predictable `build/` layout, curated output channel.
- **Programming** — `Program` (SRAM or flash), `Build and Program`,
  `Detect Board`. Flash writes prompt to back up the current flash first;
  `Write File to Board` writes any `.fs` or `.bin` you choose.
- **UI** — status-bar indicators for the toolchain and project validity, a
  build-action cluster, and a Cancel button during builds. Honours Workspace
  Trust; progress shows in the status bar, not a toast.

### Notes

- Linux x64 only for now.
- Log → Problems-panel diagnostics, VHDL synthesis, and esbuild bundling are
  planned for v0.2.
