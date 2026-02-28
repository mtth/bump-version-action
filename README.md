# Bump version action

Automatically create [semver][] tags based on [conventional commit][] messages.
This action analyzes commit messages, derives the appropriate version bump from
them, and creates a new tag.

## Usage

```yaml
jobs:
  bump:
    name: Bump version
    runs-on: docker
    steps:
      - name: Bump version
        id: bump
        uses: mtth/bump-version-action@v2
      - name: Print new tag
        run: echo ${{ steps.bump.outputs.tag }}
```

## How it works

1. Commit messages are read from the triggering event (all commit messages for
   push events, the PR title for pull request events).
2. Each message's first line is matched against the [conventional commit][]
   format (`<type>[optional scope][!]: <description>`).
3. The version bump is derived from the **highest severity** across all
   messages:
   - `!` (breaking change) &rarr; **major**, unless `ignore-breaking` is `true`
   - `feat` &rarr; **minor**
   - Any other conventional type (`fix`, `chore`, `docs`, ...) &rarr; **patch**
4. Messages are checked against configured bump rules (see below). Rules are
   applied in order, stopping at the first match.
5. The latest semver tag (e.g. `v1.2.3`) is fetched from the repository and the
   bump is applied to produce the new version. If `prefix-filter` is set, only
   tags matching that prefix are considered.
6. On push events, a new tag is created on the triggering commit's SHA. In PRs,
   the action only logs which tag it would create.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `token` | No | `${{ github.token }}` | API token used to create version tags |
| `rules` | No | `minor type feat`<br>`patch type .*` | Newline-separated bump rules in the format `<bump> <kind> <pattern>` |
| `ignore-breaking` | No | `false`, unless pre-1.0 | Ignore the breaking change marker |
| `prefix-filter` | No | `` | Only consider tags that match a stable semver prefix like `1`, `1.2`, `1.2.3`, `v1`, `v1.2`, or `v1.2.3` |

The default token works automatically in most cases. You only need to specify it
explicitly if you want to use a different token (e.g. a personal access token
with broader permissions).

### Rules

Each line contains three whitespace-separated columns:

1. The bump level: `major`, `minor`, `patch`, `noop`, `premajor:<release>`, `preminor:<release>`, or `prepatch:<release>`
2. The match type: `title` or `type`
3. The pattern to match

Rules are applied in order, and the first matching rule wins for each commit.
When a `type` rule matches, a breaking change (`!`) still escalates to **major**
unless `ignore-breaking` is `true`.

The default rules generate a `minor` bump for `feat` conventional commit types,
and `patch` for all other conventional commits.

For prerelease bumps, the release suffix is required (for example
`preminor:rc`). If the current version is already a prerelease on the same base
version and uses the same release label, the prerelease number is incremented.
If the label changes, it resets to `.1`.

When you provide explicit rules, only those rules apply. For example, the
following example will always use `patch` bumps for conventional commits and
standard merge and revert commits:

```yaml
- name: Bump version
  uses: mtth/bump-version-action@v2
  with:
    rules: |
      patch type  .*
      patch title ^(Merge|Revert)\s
```

If no rule matches a message, the action fails with an error.

## Outputs

| Output | Format | Example | Description |
|--------|--------|---------|-------------|
| `old-version` | `MAJOR.MINOR.PATCH` | `1.2.3` | The version before bumping |
| `new-version` | `MAJOR.MINOR.PATCH` | `1.3.0` | The version after bumping |
| `tag` | `vMAJOR.MINOR.PATCH` | `v1.3.0` | The created tag name |

If no existing semver tag is found, the old version defaults to `0.0.0`. When
`prefix-filter` is set and no matching tag exists, the fallback version is
derived from the prefix (for example `1` &rarr; `1.0.0`, `1.2` &rarr; `1.2.0`,
`1.2.3` &rarr; `1.2.3`).
If the computed bump is `noop`, `new-version` and `tag` will not be set (and the
tag not created). When `prefix-filter` is set, the bumped version must remain
within that prefix; otherwise the action fails. If no matching tags exist for the
prefix, the action uses the prefix base version (and ignores the bump).

For exact prefix filters like `1.2.3`, both `v1.2.3` and prereleases on that
base version (for example `v1.2.3-rc.2`) are considered when selecting the
latest version.

Tags with build metadata (for example `v1.2.3+meta`) or unsupported prerelease
suffixes are skipped with a warning.

## See also

+ https://github.com/mathieudutour/github-tag-action

[conventional commit]: https://www.conventionalcommits.org/en/v1.0.0/
[semver]: https://semver.org/
