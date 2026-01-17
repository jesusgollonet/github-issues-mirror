# github-issues-mirror

Tiny CLI to mirror a repo’s GitHub issues/PRs into a local `.github-mirror/` folder.

## Install (dev)

```bash
npm install
npm link
```

## Usage

Sync issues/PRs for the current repo (infers `origin`):

```bash
gh-issues-mirror sync
```

Sync a different repo path:

```bash
gh-issues-mirror sync /path/to/repo
```

Explicit repo slug (overrides git remote inference):

```bash
gh-issues-mirror sync --repo owner/name
```

Force a full resync:

```bash
gh-issues-mirror sync --since 1970-01-01T00:00:00Z
```

## Output

Writes JSON files to:

- `.github-mirror/state.json`
- `.github-mirror/issues/000123.json`

Each issue file includes the issue payload plus its comments.

## Notes

- Uses the `gh` CLI for auth + API access.
- v0 intentionally keeps it simple (JSON-only, includes PRs).
Mirror GitHub issues locally for offline/agent use
