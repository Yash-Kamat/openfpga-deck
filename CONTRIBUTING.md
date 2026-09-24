# Contributing to OpenFPGA Deck

Thanks for your interest. OpenFPGA Deck is young, so small, focused
contributions and bug reports help most.

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

- `src/project/` — the `fpga.yaml` schema and loader, top-module port
  reading (`ports.ts`), port → pin mapping (`pinmap.ts`), and the Project
  Settings panel (`panel.ts` for the VS Code side, `panelModel.ts` for the
  pure logic).
- `media/` — the panel's web page (`panel.js`, `panel.css`): plain DOM, no
  framework, VS Code theme colours.
- `src/boards/` — board-definition schema, registry, and the `.cst` parser.
- `src/toolchain/` — OSS CAD Suite discovery, download and integrity checks.
- `src/build/` — the pipeline: `yosys.ts` / `nextpnr.ts` / `gowinPack.ts` /
  `openFpgaLoader.ts` are **pure planners**; `synthesize.ts` /
  `placeAndRoute.ts` / `pack.ts` / `program.ts` are the stages, with every
  side effect injected so they unit-test without disk or VS Code;
  `diagnostics.ts` turns tool logs into Problems-panel entries,
  `incremental.ts` decides which stages are up to date, and `ui.ts` is the
  thin VS Code layer.
- `src/test/unit/` — Node test-runner tests, one file per area.
- `images/icon.svg` — the icon source. After editing it, regenerate the PNG
  that the Marketplace uses: `rsvg-convert -w 256 images/icon.svg -o images/icon.png`.

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
