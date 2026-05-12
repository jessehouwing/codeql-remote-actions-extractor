# CodeQL Remote Actions Extractor

A GitHub Action that downloads remote composite actions and callable workflows
into the directory structure expected by the CodeQL Actions extractor, enabling
interprocedural analysis of third-party action internals.

> **Remark**: This action assumes the following PR will eventually be merged in order to support several versions of the same composite action.

## Usage

Add this action as a step **before** the CodeQL `analyze` step in your CodeQL
workflow. It will fetch all remote actions referenced by your workflows and
place them where CodeQL can find and analyze them.

### Basic Usage

```yaml
name: CodeQL Analysis

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '0 0 * * 0'

permissions:
  contents: read

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write

    steps:
      - uses: actions/checkout@v4

      - name: Download remote actions for CodeQL
        uses: jessehouwing/codeql-remote-actions-extractor@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - uses: github/codeql-action/init@v3
        with:
          languages: actions

      - uses: github/codeql-action/analyze@v3
```

### Scanning a Custom Workflow Directory

```yaml
- uses: jessehouwing/codeql-remote-actions-extractor@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    workflow-directory: .github/workflows/custom
```

### For GHES / EMU / GitHub-DR Environments

If your instance doesn't mirror all public actions, provide a token for public
GitHub to resolve actions that live on GitHub.com:

```yaml
- uses: jessehouwing/codeql-remote-actions-extractor@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    public-github-token: ${{ secrets.PUBLIC_GITHUB_TOKEN }}
```

## Inputs

| Input                 | Description                                                                                                              | Required | Default               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------- |
| `token`               | GitHub token with `contents:read` for fetching remote action/workflow source files.                                      | Yes      | `${{ github.token }}` |
| `workflow-directory`  | Directory containing workflow files to scan.                                                                             | No       | `.github/workflows`   |
| `public-github-token` | GitHub token for public GitHub when running on GHES/EMU/DR. Used to look up actions not available on the local instance. | No       | _(empty)_             |

## Outputs

| Output            | Description                              |
| ----------------- | ---------------------------------------- |
| `actions-count`   | Number of composite actions downloaded.  |
| `workflows-count` | Number of callable workflows downloaded. |

## How It Works

1. **Workflow Scanning**: Reads all `.yml` / `.yaml` files in the configured
   workflow directory.
2. **Action Discovery**: Parses every `uses:` statement and resolves the
   referenced owner, repository, path, and ref.
3. **Remote Fetching**: Downloads each composite action (`action.yml`) and
   callable workflow file from the GitHub API.
4. **Path Placement**: Writes files into the directory layout expected by the
   CodeQL Actions extractor:
   - Composite actions →
     `.github/actions/external/{owner}/{repo}/{sha}/[path/]action.yml`
   - Callable workflows →
     `.github/workflows/external/{owner}/{repo}/{sha}/{path}/file.yml`
   - Mapping files → `.github/actions/external/mapping.yaml` and
     `.github/workflows/external/mapping.yaml`
5. **CodeQL Analysis**: With the files in place, CodeQL can follow `uses:`
   references across repository boundaries and perform interprocedural dataflow
   analysis on third-party action source code.

## Permissions

```yaml
jobs:
  analyze:
    permissions:
      contents: read # Required to fetch remote action source files
      security-events: write # Required by CodeQL to upload results
```

## Development

### Setup

```bash
npm install
```

### Build

```bash
npm run bundle
```

### Test

```bash
npm test
```

## License

MIT
