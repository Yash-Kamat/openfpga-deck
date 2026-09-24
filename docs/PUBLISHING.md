# Publishing OpenFPGA Deck to the VS Code Marketplace

One-time setup, then `vsce publish` for every release.

## One-time: publisher + token

The Marketplace is run on top of Azure DevOps, so the accounts live there.

1. **Azure DevOps organisation.** Sign in at <https://dev.azure.com> with a
   Microsoft account (a personal one is fine) and create an organisation if
   prompted. The org itself is just a container — the name doesn't matter.

2. **Personal Access Token (PAT).**
   - <https://dev.azure.com> → your avatar → **Personal access tokens** →
     **New Token**.
   - **Organization:** *All accessible organizations*.
   - **Expiration:** up to a year.
   - **Scopes:** *Custom defined* → **Marketplace** → **Manage**.
   - Create it and copy the token now — it is shown only once.

3. **Publisher.** Go to <https://marketplace.visualstudio.com/manage>, sign
   in with the same account, **Create publisher**:
   - **ID:** `openfpga-deck` — this must exactly match the `publisher` field
     in `package.json`. Pick another ID if you like and update `package.json`
     to match.
   - **Name:** `OpenFPGA Deck` (display only, can change later).

## Every release

1. On a `release/vX.Y.Z` branch: bump `version` in `package.json` (and
   `package-lock.json`), date the CHANGELOG section, then build a test VSIX:

   ```sh
   npm ci
   npm run compile && npm run lint && npm test
   npm run package        # -> openfpga-deck-linux-x64-X.Y.Z.vsix
   ```

   Install it with **Extensions → `...` → Install from VSIX…** and test it on
   the board.
2. Push the branch, open a pull request, wait for CI to pass, merge it on
   GitHub. The README images load from `main`, so merge before publishing.
3. On an up-to-date `main`, check that `git status` shows no untracked
   files: `vsce` packages what is on disk, not what is in git.
   Then:

   ```sh
   npx vsce login openfpga-deck        # paste the PAT; once per machine
   npx vsce publish --target linux-x64
   ```

4. Tag the release and push the tag:

   ```sh
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

5. On GitHub: **Releases → Draft a new release**, choose the tag, paste the
   CHANGELOG section as the notes, attach the `.vsix`, **Publish release**.

## Platform targeting

OpenFPGA Deck is published as a **platform-specific** extension for
`linux-x64` only — the sole platform the OSS CAD Suite flow is tested on.
The Marketplace then offers it for installation only on 64-bit Linux; users
on Windows, macOS or Linux ARM never see an installable build, which keeps
the listing honest instead of implying "Universal" support.

- Adding a platform later means publishing another targeted build for it
  (`--target darwin-arm64`, `--target win32-x64`, …) from the same version.
  See <https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions>
  for the full target list.
- `0.1.0` was published as a universal build, so Windows and macOS users
  could still install it. Remove that one version after a targeted release
  is live: <https://marketplace.visualstudio.com/manage> → OpenFPGA Deck →
  **More Actions → Reports → Delete this version**, then type the extension
  name to confirm. The other versions stay.
- The listing appears at
  `https://marketplace.visualstudio.com/items?itemName=openfpga-deck.openfpga-deck`
  within a few minutes; the pipeline verification can take longer.

## Notes

- Keep `CHANGELOG.md` current — the Marketplace shows it on the listing.
- `README.md` **is** the listing page. Relative links in it are rewritten to
  point at the repository's `main` branch, so keep the repo public.
- Azure is retiring global PATs on 2026-12-01; the successor is Entra ID /
  managed-identity auth via `vsce`. Revisit before then.
