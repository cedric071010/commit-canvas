# Commit Canvas

Commit Canvas is an educational 53 × 7 GitHub contribution-graph drawing tool. The interface defaults to English and provides a runtime **English / 简体中文** language switch. It supports two deliberately separate modes:

- **Static mode**, including GitHub Pages, keeps drawing, design files, contribution snapshots, and reviewable script export offline.
- **Live localhost mode** reads the active user's real contribution calendar and can write real commits to one strictly managed practice repository.

> Decorative commits are not evidence of work, skill, or productivity. Use Commit Canvas to learn about Git metadata and GitHub contribution rules—not to fabricate experience or mislead people.

## Static mode: offline drawing and export

Use the static GitHub Pages deployment, or start the local static server from the repository root:

```powershell
npm.cmd run serve
```

On macOS or Linux, use `npm run serve`. Then open <http://127.0.0.1:4173>.

Static mode can:

- draw on the 53 × 7 canvas with five planned intensity levels;
- save and restore design JSON;
- import a previously generated contribution snapshot as a read-only background;
- export reviewable Bash or PowerShell scripts.

Static mode has no GitHub login capability and does not read or modify GitHub. The **Submit to GitHub** action performs a real remote update only when the page is served by the live localhost companion described below.

The exported scripts are an advanced offline fallback. They create commits only in the current local Git repository and contain no token, network request, repository initialization, or `git push`. Read the complete script before running it in a new, standalone practice repository you own.

## Optional offline contribution snapshots

An authenticated GitHub CLI session can create a credential-free JSON snapshot for static mode:

```powershell
npm.cmd run snapshot -- --end-date 2026-08-13 --output .\contribution-snapshot.commit-canvas-snapshot.json
```

On macOS or Linux, use `npm run snapshot -- ...`. Keep `--end-date` aligned with the canvas end date. The generated file contains no token or cookie, but it does contain the account name and daily activity statistics, so it is personal data. Keep it local and do not attach it to public issues or pull requests. Snapshot files use the `.commit-canvas-snapshot.json` suffix and are ignored by Git.

A snapshot represents only the moment it was generated. Refresh it after account activity or date changes and before final export. It is not embedded in ordinary design JSON.

## Live localhost mode: real GitHub writes

### Prerequisites

- Install Node.js and the GitHub CLI (`gh`).
- Each user must run `gh auth login` and authenticate with **their own GitHub account**.
- The GitHub CLI documentation lists `repo`, `read:org`, and `gist` as the minimum scopes for its classic-token login flow. Use `gh auth status` to inspect the current login and follow `gh` guidance if an older login or organization policy requires reauthorization.

Commit Canvas has no hard-coded account. On every run, the localhost companion asks the already-authenticated `gh` session for its active account and derives the account login and GitHub-provided `noreply` email dynamically. Switching the active `gh` account therefore changes which account the companion validates and uses.

If `GH_TOKEN` or `GITHUB_TOKEN` is set, GitHub CLI gives that environment token priority over credentials stored by `gh auth login`. Run `gh auth status --active` before starting Commit Canvas and verify the account shown in the Live UI before approving a write. The companion must run under the same local OS user/session that owns the selected `gh` login; the hosted static page cannot share or reuse another person's authentication.

Start live mode from the repository root:

```powershell
npm.cmd run live
```

On macOS or Linux, use `npm run live`. The companion listens only on `127.0.0.1:4173` and opens the UI automatically.

Live mode performs real operations:

1. It reads the active account and real contribution calendar through the authenticated `gh` CLI.
2. It creates or connects to a dedicated repository named `commit-canvas` or `commit-canvas-*`.
3. After a final review and explicit confirmation, it uses the GitHub Git Data API to create an empty commit chain that reuses the current tree.
4. It rechecks the account, managed repository, and reviewed branch head, then updates the default branch without force.

The final live button really updates GitHub. There is no in-page undo after confirmation.

## Privacy and security boundaries

- The browser never receives a GitHub token, cookie, or `Authorization` header. Authentication and GitHub API calls stay between the local Node.js companion, the installed `gh` CLI, and GitHub.
- The browser receives only a minimal account summary needed for review: login, numeric account ID, display name, and the derived GitHub `noreply` address. It never receives the full `/user` response, private email list, organization list, plan, billing, or private-repository metadata.
- GitHub CLI normally stores credentials in the operating-system credential store. Its documented fallback can use a plain-text file when no credential store is available; users should review `gh auth status` and their local CLI setup on shared or untrusted computers.
- Browser requests are limited to same-origin `/api/...` routes on the localhost companion. The service does not listen on a LAN address, rejects cross-origin requests, and checks the Host, Origin, and per-session request token.
- The short-lived request token used between the page and companion is not a GitHub credential.
- A submitted job may leave a credential-free job ID in browser session storage so interrupted status polling can resume. Clearing or abandoning that local ID does not cancel, undo, or determine the remote result; check the repository on GitHub first.
- Contribution snapshots and exported designs may contain personal activity or user-created content. Their runtime/export patterns are ignored by Git, but users must still keep them out of commits, issues, and pull requests.
- No personal proof-account data belongs in this repository, its fixtures, or documentation.

## Managed-repository restrictions

Live writes are restricted to a repository that passes every management check:

- its name is exactly `commit-canvas` or follows the conservative `commit-canvas-*` pattern;
- the active authenticated account owns it;
- it is not a fork;
- its reachable history retains the Commit Canvas management marker and is linear;
- writes target its default branch, not an arbitrary branch or working repository.

The companion revalidates these conditions before writing. A branch-head change after review stops the operation and requires reconnection and a new review. Reference updates are never forced. Commit Canvas does not delete repositories, rewrite existing history, or silently hide operations.

The managed-history scan is capped at 2,000 commits so idempotency markers can be checked within a bounded history. At that limit the repository remains viewable, but further drawing requires a new managed `commit-canvas-*` repository.

If a submitted job's status becomes unknown because polling was interrupted or the companion restarted, do not assume failure. Inspect the target repository on GitHub before resuming the query or discarding the local job record.

## Contribution eligibility and visual limits

GitHub—not Commit Canvas—decides whether a commit appears on a profile contribution graph. At minimum, check that:

- the author email belongs to the GitHub account; live mode uses the dynamically derived GitHub `noreply` email;
- the commit is in a standalone, non-fork repository;
- the commit reaches the repository's default branch, or an otherwise eligible `gh-pages` branch;
- GitHub's repository-relationship conditions are satisfied;
- private-contribution visibility settings allow the intended profile display;
- the author date, time zone, and intended calendar date are correct.

Even eligible contributions can take up to 24 hours to be indexed. GitHub calculates graph intensity from the selected time range, activity distribution, theme, and current site behavior. The five canvas levels are planning aids and cannot guarantee exact GitHub colors or shades.

Official references:

- [Profile contributions reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference)
- [Troubleshooting missing contributions](https://docs.github.com/en/account-and-profile/how-tos/contribution-settings/troubleshooting-missing-contributions)
- [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login)

## Safety limits and responsible use

- A single plan has a hard limit of 500 commits.
- Plans of 200 commits or more require additional confirmation.
- Prefer small patterns and low intensities.
- These safeguards are not GitHub permission or an automation quota. Follow the [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies).
- Use only practice repositories you own. Never describe decorative activity as genuine development work.
- Repository deletion can be irreversible. Commit Canvas does not delete a managed repository; verify its full name and contents before handling it yourself on GitHub.

## Development and testing

Run the complete syntax and test suite:

```powershell
npm.cmd run check
```

On macOS or Linux, use `npm run check`. Individual development commands are:

```powershell
npm.cmd run serve
npm.cmd run live
npm.cmd run snapshot -- --help
npm.cmd test
```

Default tests and CI must use anonymized fixtures and injected fake GitHub services; they must not contact a real account. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

## Attribution and license

The educational concept was inspired by the MIT-licensed [gelstudios/gitfiti](https://github.com/gelstudios/gitfiti); Commit Canvas does not copy its implementation. Commit Canvas is an independent community project and is not affiliated with, endorsed by, or sponsored by GitHub, Inc.

This project is released under the [MIT License](LICENSE). Copyright © 2026 Cedric / cedric071010.
