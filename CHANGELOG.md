# Changelog

All notable changes to OpenFPGA Deck are documented here.

## Unreleased

### Added

- **Full Tang Nano 20K pin map**, from Sipeed's rev 3923 schematic: HDMI,
  RGB LCD, microSD, audio, BL616 SPI, config flash, the MS5351 clocks and
  header GPIO, each pin with a `group` and a `note`, plus the J5/J6 header
  layout. Tested on hardware: LEDs, buttons, UART, WS2812, MS5351 clocks
  and HDMI video. The other groups are marked untested in the board file.
- The build releases the dual-purpose configuration pins as GPIO when a
  design uses them: nextpnr `--vopt sspi_as_gpio`, and gowin_pack
  `--sspi_as_gpio` / `--mspi_as_gpio`.

- **Port → pin mapping** (groundwork for the project settings panel; no UI
  yet): read the top module's ports with yosys, check a port → board-pin
  mapping (pins used twice, unknown pins, unmapped ports, direction
  clashes), generate the `.cst` from it or read it back from an existing
  one, and generate a top module from chosen board pins.
- Board pins take an optional `dir` (`input` / `output` / `inout`), the
  default direction for a generated port. Set on the Tang Nano 20K except
  the BL616 SPI link and header GPIO.

### Changed

- Tang Nano 20K buttons are renamed `btn_s1` / `btn_s2` and are active-high
  (pull-down), as on the schematic.

## 0.1.1 — 2026-09-24

### Changed

- Published as a **linux-x64 platform-specific** build. The Marketplace now
  offers OpenFPGA Deck only on 64-bit Linux, the one platform it is tested
  on, instead of listing it as universal.

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
