# Contributing to OpenFPGA Deck

Thanks for your interest. OpenFPGA Deck is early — small, focused
contributions and bug reports are the most useful right now.

## Development setup

```sh
npm install
npm run compile      # tsc -> out/
npm run lint         # eslint src
npm test             # node --test over out/test/**
```

Press **F5** in VS Code to launch an Extension Development Host with the
extension loaded.

## How the code is organised

- `src/project/` — the `fpga.yaml` schema, loader, and the init wizard.
- `src/boards/` — board-definition schema, registry, and the `.cst` parser.
- `src/toolchain/` — OSS CAD Suite discovery, download and integrity checks.
- `src/build/` — the pipeline: `yosys.ts` / `nextpnr.ts` / `gowinPack.ts` /
  `openFpgaLoader.ts` are **pure planners**; `synthesize.ts` /
  `placeAndRoute.ts` / `pack.ts` / `program.ts` are the stages, with every
  side effect injected so they unit-test without disk or VS Code;
  `ui.ts` is the thin VS Code layer.
- `src/test/unit/` — Node test-runner tests, one file per area.

Prefer the injected-host pattern: keep logic pure and testable, keep VS Code
and the filesystem at the edges.

## Guidelines

- Match the style of the surrounding code.
- Add or update tests for behaviour changes; keep `npm test` green.
- Follow the security posture in [SECURITY.md](SECURITY.md) — argument
  arrays, no shell strings, no new network calls, strict path checks.
- One logical change per pull request; describe what you verified.

## Adding a board

Add `boards/<vendor>/<board-id>.yaml` following the Tang Nano 20K file. Cite
your pin sources in a header comment. The board flows through the pipeline
with no code changes if the family is already supported by nextpnr /
gowin_pack.
