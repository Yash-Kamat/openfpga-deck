# OpenFPGA Deck

Take an FPGA design from HDL to a running board without leaving VS Code.
OpenFPGA Deck orchestrates the open-source FPGA toolchain — the
[YosysHQ OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build) — so
you get an IDE-style flow:

```
write HDL  →  Synthesize (Yosys)  →  Place & Route (nextpnr-himbaechel)
           →  Pack (gowin_pack)   →  Program (openFPGALoader)  →  board
```

**First supported board:** Sipeed Tang Nano 20K (Gowin GW2AR-LV18QN88C8/I7).
More boards and families are planned.

> Status: **v0.1** — the vertical slice works end to end and is verified on
> real hardware. It is deliberately small; see the [roadmap](ROADMAP.md).

## What it does

- **Initialize Project** — a guided wizard scaffolds `fpga.yaml`, a Verilog
  (or SystemVerilog) top module, a Gowin `.cst` constraints file generated
  from the board definition, and a `build/` layout.
- **Toolchain management** — finds an existing OSS CAD Suite on `PATH` or in
  common locations, or downloads a release straight from the official GitHub
  repo (integrity-checked), keeping each release side by side.
- **Build** — `Synthesize`, `Place and Route`, `Pack Bitstream`, or the whole
  chain with one **Build**. Output is streamed to the *OpenFPGA Deck* channel;
  full logs land in `build/logs/`. A resource-utilisation and Fmax summary is
  shown after place & route.
- **Program** — load the bitstream into volatile **SRAM** or persistent
  **flash**; **Build and Program** does both in one step; **Detect Board**
  is a quick preflight.
- **Flash safety** — before a flash write, OpenFPGA Deck offers to back up
  the current flash contents to `build/backup/`. **Write File to Board**
  writes any `.fs` bitstream or `.bin` image you pick — to restore a backup
  or flash a prebuilt bitstream.
- A compact status-bar cluster for the build actions, with a Cancel button
  while a build runs.

## Requirements

- **VS Code 1.85+**, Linux x64 (other platforms follow as the OSS CAD Suite
  supports them — untested platforms are not claimed as supported).
- **The OSS CAD Suite.** If you don't have it, run **OpenFPGA Deck: Download
  Toolchain** and the extension fetches and verifies a release for you. It is
  a self-contained directory — nothing is installed system-wide.
- For programming: USB access to the board. On Linux that usually means
  installing openFPGALoader's udev rules and being in the `plugdev` group.

## Quick start

1. Open an empty folder and trust it. OpenFPGA Deck offers to initialize a
   project — accept, pick **Tang Nano 20K**, a top module name, **Verilog**,
   and the **blink** starter design.
2. If prompted, run **OpenFPGA Deck: Download Toolchain** (or point
   `openfpga.toolchain.path` at an existing OSS CAD Suite).
3. Click **⚡ Build** in the status bar (or run **OpenFPGA Deck: Build**).
4. Plug in the board and click **🚀 Build and Program** → choose **SRAM**.
   The on-board LEDs blink.

## Settings

| Setting | Purpose |
| --- | --- |
| `openfpga.toolchain.path` | Absolute path to an OSS CAD Suite install. Empty = auto-detect. |
| `openfpga.toolchain.installDir` | Where **Download Toolchain** keeps releases (default `~/fpga-toolchain`). |
| `openfpga.toolchain.keepDownloads` | Keep the downloaded `.tgz` archives after extraction (default on). |

All three are `machine-overridable`, so a workspace cannot point the
extension at an arbitrary executable.

## Security & privacy

- **No telemetry, no analytics.** No source, project names or machine data
  ever leave your machine.
- Every tool is run as an executable with an argument array — never a shell
  string.
- The only network activity is the toolchain download (only from
  `github.com/YosysHQ/oss-cad-suite-build/releases/`, over HTTPS,
  integrity-checked) and the GitHub release API.
- The extension stays inactive until you trust the workspace.

## Credits

Built on the work of [YosysHQ](https://github.com/YosysHQ) (Yosys, nextpnr),
[Project Apicula](https://github.com/YosysHQ/apicula) (`gowin_pack`, Gowin
device data), and [openFPGALoader](https://github.com/trabucayre/openFPGALoader).
Tang Nano 20K pin data cross-checked against Sipeed's examples and
[litex-boards](https://github.com/litex-hub/litex-boards).

## License

[Apache-2.0](LICENSE).
