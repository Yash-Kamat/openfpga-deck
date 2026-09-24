# Roadmap

OpenFPGA Deck runs the open-source FPGA flow (YosysHQ OSS CAD Suite) inside
VS Code: HDL → synthesis → place and route → bitstream → board. Every release
is verified on a real Sipeed Tang Nano 20K. Platforms other than Linux x64
are added only once they are tested.

## Released

| Version | Date | Highlights |
| --- | --- | --- |
| 0.2.0 | 2026-09-25 | Project Settings panel with port → pin mapping, full Tang Nano 20K pin map, Problems-panel diagnostics, incremental builds, Clean |
| 0.1.1 | 2026-09-24 | Published as a linux-x64 build |
| 0.1.0 | 2026-08-30 | First release: project file, toolchain download, build, program, flash backup |

Details are in the [changelog](CHANGELOG.md).

## v0.3 — seeing the pins

- **Board pin diagram.** A drawing of a known board's headers with each
  pin's number and what is assigned to it (STM32CubeMX-style), plus the
  on-board peripherals by group. Built from the board file's `headers`,
  `group` and `note`, so pin numbers stay visible after the headers are
  soldered.
- **Chip-level IO planner.** For custom hardware or a bare chip: a
  package pin grid to assign top-level ports to physical pins, with pin data
  from Project Apicula's device databases. `nextpnr`'s Qt floorplan view is
  the rendering reference.

Both are views of the same port → pin mapping (`src/project/pinmap.ts`) and
write the `.cst` through it.

## v0.4 — your own boards

- **Custom board files.** Load board files from a user folder (a setting
  and/or `boards/` in the project) next to the shipped ones, through the same
  validator, with the format documented. The chip pin grid belongs to the
  FPGA package, so it becomes a separate device file that board files point
  to.

## Later

**Build**
- VHDL synthesis through the `ghdl` yosys plugin in the OSS CAD Suite
  (`.vhd` / `.vhdl` sources are rejected with a clear message today).
- Per-clock timing constraints instead of one global `--freq` from the
  board's first clock.
- Track `include`d files in incremental builds.
- esbuild bundling to shrink the VSIX and speed up activation.
- Integration tests over the injected-IO flows, and a coverage pass.

**Board and programming**
- Programmer / cable selection when several boards or FTDI cables are
  attached (`openFPGALoader --ftdi-serial` / `-c`).
- Serial monitor for the board's UART in a VS Code terminal, for
  `printf`-style debugging and SoC consoles.
- Rotating flash backups and a one-click "restore latest".

**Editor and toolchain**
- Coloured build console in a pseudoterminal (VS Code's `log` output
  grammar colours every number, so it was rejected).
- Uninstall Toolchain, with a guard against removing the active release.
- Floorplanner: placement-region constraints for place and route.

**Reach**
- Simulation: Verilator, Icarus Verilog, GTKWave / Surfer.
- More platforms: Windows, macOS (Intel and Apple Silicon), Linux ARM64.
- More boards and families: further Gowin boards, then iCE40 (`icepack`) and
  ECP5 (`ecppack`).

## Principles

OpenFPGA Deck orchestrates existing tools and never bundles or reimplements
them. The security rules every change follows are in
[SECURITY.md](SECURITY.md).
