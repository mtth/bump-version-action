# Bump version

Sample usage:

```yaml
jobs:
  # ...
  bump:
    name: Bump version
    runs-on: docker
    steps:
      - name: Bump version
        uses: https://github.com/mtth/bump-version-action@v1
```

See also:

* https://github.com/mathieudutour/github-tag-action
