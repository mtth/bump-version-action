# Bump version action

Automatically create [semver][] tags based on [conventional commit][] messages.
This action analyzes commit messages from push and pull request events, derives
the appropriate version bump, and creates a new tag.

## Usage

```yaml
jobs:
  bump:
    name: Bump version
    runs-on: docker
    steps:
      - name: Bump version
        id: bump
        uses: mtth/bump-version-action@v1
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
   - `!` (breaking change) &rarr; **major**
   - `feat` &rarr; **minor**
   - Any other conventional type (`fix`, `chore`, `docs`, ...) &rarr; **patch**
4. Messages that don't match conventional commit format are checked against
   configurable custom bump patterns (see below).
5. The latest semver tag (e.g. `v1.2.3`) is fetched from the repository and the
   bump is applied to produce the new version.
6. A new tag is created on the triggering commit's SHA.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `token` | No | `${{ github.token }}` | API token used to create version tags |
| `custom-bumps` | No | `minor ^(Merge\|Revert)\s` | Newline-separated `<bump> <regex>` pairs for non-conventional commit messages |

The default token works automatically on both Forgejo and GitHub. You only need
to specify it explicitly if you want to use a different token (e.g. a personal
access token with broader permissions).

### Custom bumps

Messages that don't follow conventional commit format are matched against custom
bump patterns. Each line contains a bump level (`major`, `minor`, or `patch`)
followed by a space and a regular expression. The first matching pattern wins.

The default value handles auto-generated merge and revert commit messages:

```yaml
custom-bumps: |
  minor ^(Merge|Revert)\s
```

A more detailed example:

```yaml
- name: Bump version
  uses: mtth/bump-version-action@v1
  with:
    custom-bumps: |
      minor ^(Merge|Revert)\s
      patch ^Bump\s
```

If no pattern matches a non-conventional message, the action fails with an
error.

## Outputs

| Output | Format | Example | Description |
|--------|--------|---------|-------------|
| `old-version` | `MAJOR.MINOR.PATCH` | `1.2.3` | The version before bumping |
| `new-version` | `MAJOR.MINOR.PATCH` | `1.3.0` | The version after bumping |
| `tag` | `vMAJOR.MINOR.PATCH` | `v1.3.0` | The created tag name |

If no existing semver tag is found, the old version defaults to `0.0.0`.

## See also

+ https://github.com/mathieudutour/github-tag-action

[conventional commit]: https://www.conventionalcommits.org/en/v1.0.0/
[semver]: https://semver.org/
