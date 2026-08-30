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

From the repo root, with a clean `main` checked out:

```sh
npm ci
npm run compile && npm run lint && npm test     # sanity
npx vsce login openfpga-deck                     # paste the PAT, once per machine
npx vsce publish                                 # publishes the version in package.json
```

- To bump and publish in one step: `npx vsce publish patch` (or `minor`).
- To only build the artifact without publishing: `npx vsce package` →
  `openfpga-deck-<version>.vsix`. You can install that VSIX locally with
  **Extensions: Install from VSIX…** to test.
- The listing appears at
  `https://marketplace.visualstudio.com/items?itemName=openfpga-deck.openfpga-deck`
  within a few minutes; the pipeline verification can take longer.

## Notes

- Keep `CHANGELOG.md` current — the Marketplace shows it on the listing.
- `README.md` **is** the listing page. Relative links in it are rewritten to
  point at the repository's `main` branch, so keep the repo public.
- Azure is retiring global PATs on 2026-12-01; the successor is Entra ID /
  managed-identity auth via `vsce`. Revisit before then.
