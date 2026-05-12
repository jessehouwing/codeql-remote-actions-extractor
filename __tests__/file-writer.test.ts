/**
 * Unit tests for src/file-writer.ts
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest
} from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import * as github from '../__fixtures__/github.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'

// Mock @actions/core and @actions/github before importing FileWriter
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => github)

const { FileWriter } = await import('../src/file-writer.js')

/** Helper: mock getCommit to resolve a ref to a SHA */
function mockGetCommit(sha: string) {
  github.mockOctokit.rest.repos.getCommit.mockResolvedValueOnce({
    data: { sha }
  })
}

/** Helper: mock getContent to return base64-encoded content */
function mockGetContent(content: string) {
  github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
    data: { content: Buffer.from(content).toString('base64') }
  })
}

describe('FileWriter', () => {
  let tempDir: string

  beforeEach(() => {
    jest.clearAllMocks()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-writer-test-'))
    // Default: local repo check succeeds
    github.mockOctokit.rest.repos.get.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('writeExternalDependencies', () => {
    it('writes a composite action to the correct SHA-based path', async () => {
      const actionYml = `name: Test\nruns:\n  using: node20\n  main: index.js\n`
      mockGetCommit('abc123def456')
      mockGetContent(actionYml)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'actions',
            repo: 'cache',
            ref: 'v4',
            uses: 'actions/cache@v4'
          }
        ],
        tempDir
      )

      expect(result.actionsWritten).toBe(1)
      expect(result.workflowsWritten).toBe(0)
      expect(result.errors).toHaveLength(0)

      const expectedPath = path.join(
        tempDir,
        '.github',
        'actions',
        'external',
        'actions',
        'cache',
        'abc123def456',
        'action.yml'
      )
      expect(fs.existsSync(expectedPath)).toBe(true)
      expect(fs.readFileSync(expectedPath, 'utf8')).toBe(actionYml)

      // mapping.yaml should exist
      const mappingPath = path.join(
        tempDir,
        '.github',
        'actions',
        'external',
        'mapping.yaml'
      )
      expect(fs.existsSync(mappingPath)).toBe(true)
      const mapping = yaml.parse(fs.readFileSync(mappingPath, 'utf8'))
      expect(mapping['actions/cache']).toEqual({ v4: 'abc123def456' })
    })

    it('writes an action with actionPath to the correct SHA-based subdirectory', async () => {
      const actionYml = `name: Setup\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n`
      mockGetCommit('sha789')
      mockGetContent(actionYml)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'TanStack',
            repo: 'config',
            actionPath: '.github/setup',
            ref: 'main',
            uses: 'TanStack/config/.github/setup@main'
          }
        ],
        tempDir
      )

      expect(result.actionsWritten).toBe(1)

      const expectedPath = path.join(
        tempDir,
        '.github',
        'actions',
        'external',
        'TanStack',
        'config',
        'sha789',
        '.github',
        'setup',
        'action.yml'
      )
      expect(fs.existsSync(expectedPath)).toBe(true)
    })

    it('writes a callable workflow to the correct SHA-based path', async () => {
      const workflowYml = `name: CI\non:\n  workflow_call:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`
      mockGetCommit('workflowsha123')
      mockGetContent(workflowYml)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'org',
            repo: 'repo',
            actionPath: '.github/workflows/ci.yml',
            ref: 'main',
            uses: 'org/repo/.github/workflows/ci.yml@main'
          }
        ],
        tempDir
      )

      expect(result.workflowsWritten).toBe(1)
      expect(result.actionsWritten).toBe(0)

      const expectedPath = path.join(
        tempDir,
        '.github',
        'workflows',
        'external',
        'org',
        'repo',
        'workflowsha123',
        '.github',
        'workflows',
        'ci.yml'
      )
      expect(fs.existsSync(expectedPath)).toBe(true)
      expect(fs.readFileSync(expectedPath, 'utf8')).toBe(workflowYml)

      // workflow mapping.yaml should exist
      const mappingPath = path.join(
        tempDir,
        '.github',
        'workflows',
        'external',
        'mapping.yaml'
      )
      expect(fs.existsSync(mappingPath)).toBe(true)
      const mapping = yaml.parse(fs.readFileSync(mappingPath, 'utf8'))
      expect(mapping['org/repo']).toEqual({ main: 'workflowsha123' })
    })

    it('deduplicates dependencies by key', async () => {
      const actionYml = `name: Test\nruns:\n  using: node20\n  main: index.js\n`
      mockGetCommit('sha111')
      mockGetContent(actionYml)

      const writer = new FileWriter('test-token')
      const dep = {
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4',
        uses: 'actions/checkout@v4'
      }
      const result = await writer.writeExternalDependencies(
        [dep, dep, dep],
        tempDir
      )

      expect(result.actionsWritten).toBe(1)
      // Only one getCommit + one getContent call should be made
      expect(
        github.mockOctokit.rest.repos.getCommit
      ).toHaveBeenCalledTimes(1)
      expect(
        github.mockOctokit.rest.repos.getContent
      ).toHaveBeenCalledTimes(1)
    })

    it('handles API errors gracefully', async () => {
      github.mockOctokit.rest.repos.getCommit.mockRejectedValue(
        new Error('Not found')
      )

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'private-org',
            repo: 'secret-action',
            ref: 'v1',
            uses: 'private-org/secret-action@v1'
          }
        ],
        tempDir
      )

      // Error from getCommit is caught
      expect(result.actionsWritten).toBe(0)
      expect(result.errors).toHaveLength(1)
    })

    it('returns zero when action.yml and action.yaml both not found', async () => {
      // getCommit succeeds but both action files fail
      mockGetCommit('sha222')
      github.mockOctokit.rest.repos.getContent
        .mockRejectedValueOnce(new Error('Not found'))
        .mockRejectedValueOnce(new Error('Not found'))

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'actions',
            repo: 'cache',
            ref: 'v4',
            uses: 'actions/cache@v4'
          }
        ],
        tempDir
      )

      // Not an error, just not written (action file not found)
      expect(result.actionsWritten).toBe(0)
      expect(result.errors).toHaveLength(0)
    })

    it('falls back to action.yaml when action.yml is not found', async () => {
      const actionYml = `name: Test\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n`
      mockGetCommit('sha333')
      // First call (action.yml) fails, second (action.yaml) succeeds
      github.mockOctokit.rest.repos.getContent
        .mockRejectedValueOnce(new Error('Not found'))
        .mockResolvedValueOnce({
          data: { content: Buffer.from(actionYml).toString('base64') }
        })

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'actions',
            repo: 'cache',
            ref: 'v4',
            uses: 'actions/cache@v4'
          }
        ],
        tempDir
      )

      expect(result.actionsWritten).toBe(1)
      // Should have tried action.yml first, then action.yaml
      expect(
        github.mockOctokit.rest.repos.getContent
      ).toHaveBeenCalledTimes(2)
    })

    it('recursively downloads nested composite action dependencies', async () => {
      const outerAction = `name: Outer\nruns:\n  using: composite\n  steps:\n    - uses: actions/cache@v3\n    - run: echo outer\n      shell: bash\n`
      const innerAction = `name: Inner\nruns:\n  using: node20\n  main: index.js\n`

      // Outer action: resolve ref + fetch content
      mockGetCommit('outersha')
      mockGetContent(outerAction)
      // Inner action: resolve ref + fetch content
      mockGetCommit('innersha')
      mockGetContent(innerAction)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'some-org',
            repo: 'setup-action',
            ref: 'main',
            uses: 'some-org/setup-action@main'
          }
        ],
        tempDir
      )

      expect(result.actionsWritten).toBe(2)

      // Both files should exist at SHA-based paths
      expect(
        fs.existsSync(
          path.join(
            tempDir,
            '.github',
            'actions',
            'external',
            'some-org',
            'setup-action',
            'outersha',
            'action.yml'
          )
        )
      ).toBe(true)
      expect(
        fs.existsSync(
          path.join(
            tempDir,
            '.github',
            'actions',
            'external',
            'actions',
            'cache',
            'innersha',
            'action.yml'
          )
        )
      ).toBe(true)
    })

    it('recursively downloads nested workflow job-level callable workflows', async () => {
      const workflowYml = `name: CI\non:\n  workflow_call:\njobs:\n  inner:\n    uses: other-org/repo/.github/workflows/build.yml@v1\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`
      const innerWorkflowYml = `name: Build\non:\n  workflow_call:\njobs:\n  compile:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo build\n`

      // Outer workflow: resolve ref + fetch content
      mockGetCommit('outerworkflowsha')
      mockGetContent(workflowYml)
      // Inner workflow: resolve ref + fetch content
      mockGetCommit('innerworkflowsha')
      mockGetContent(innerWorkflowYml)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'org',
            repo: 'repo',
            actionPath: '.github/workflows/ci.yml',
            ref: 'main',
            uses: 'org/repo/.github/workflows/ci.yml@main'
          }
        ],
        tempDir
      )

      expect(result.workflowsWritten).toBe(2)
    })

    it('prevents infinite recursion with circular references', async () => {
      const actionA = `name: A\nruns:\n  using: composite\n  steps:\n    - uses: org/action-b@v1\n`
      const actionB = `name: B\nruns:\n  using: composite\n  steps:\n    - uses: org/action-a@v1\n`

      // action-a: resolve + fetch
      mockGetCommit('sha-a')
      mockGetContent(actionA)
      // action-b: resolve + fetch
      mockGetCommit('sha-b')
      mockGetContent(actionB)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'org',
            repo: 'action-a',
            ref: 'v1',
            uses: 'org/action-a@v1'
          }
        ],
        tempDir
      )

      // Both should be written but no infinite loop
      expect(result.actionsWritten).toBe(2)
    })

    it('handles invalid YAML content gracefully', async () => {
      const invalidYaml = `{invalid: yaml: content: [\n`
      mockGetCommit('sha444')
      mockGetContent(invalidYaml)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'actions',
            repo: 'cache',
            ref: 'v4',
            uses: 'actions/cache@v4'
          }
        ],
        tempDir
      )

      // Should still write the file, just not recurse
      expect(result.actionsWritten).toBe(1)
    })

    it('skips local ./ references in nested content', async () => {
      const actionYml = `name: Test\nruns:\n  using: composite\n  steps:\n    - uses: ./local-step\n    - uses: actions/checkout@v4\n`
      const checkoutYml = `name: Checkout\nruns:\n  using: node20\n  main: index.js\n`

      // Outer: resolve + fetch
      mockGetCommit('sha555')
      mockGetContent(actionYml)
      // Inner (actions/checkout): resolve + fetch
      mockGetCommit('sha666')
      mockGetContent(checkoutYml)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'org',
            repo: 'action',
            ref: 'v1',
            uses: 'org/action@v1'
          }
        ],
        tempDir
      )

      // Should write both org/action and actions/checkout, but skip ./local-step
      expect(result.actionsWritten).toBe(2)
    })

    it('handles multiple dependencies in one call', async () => {
      const actionYml1 = `name: Checkout\nruns:\n  using: node20\n  main: index.js\n`
      const actionYml2 = `name: Cache\nruns:\n  using: node20\n  main: index.js\n`

      // checkout: resolve + fetch
      mockGetCommit('sha-checkout')
      mockGetContent(actionYml1)
      // cache: resolve + fetch
      mockGetCommit('sha-cache')
      mockGetContent(actionYml2)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'actions',
            repo: 'checkout',
            ref: 'v4',
            uses: 'actions/checkout@v4'
          },
          {
            owner: 'actions',
            repo: 'cache',
            ref: 'v4',
            uses: 'actions/cache@v4'
          }
        ],
        tempDir
      )

      expect(result.actionsWritten).toBe(2)
      expect(result.errors).toHaveLength(0)
    })

    it('handles workflow with step-level uses in nested content', async () => {
      const workflowYml = `name: CI\non:\n  workflow_call:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo hi\n`
      const checkoutYml = `name: Checkout\nruns:\n  using: node20\n  main: index.js\n`

      // Workflow: resolve + fetch
      mockGetCommit('wfsha')
      mockGetContent(workflowYml)
      // Nested checkout action: resolve + fetch
      mockGetCommit('checkoutsha')
      mockGetContent(checkoutYml)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'org',
            repo: 'repo',
            actionPath: '.github/workflows/ci.yml',
            ref: 'main',
            uses: 'org/repo/.github/workflows/ci.yml@main'
          }
        ],
        tempDir
      )

      expect(result.workflowsWritten).toBe(1)
      expect(result.actionsWritten).toBe(1)
    })

    it('writes different versions of same action to separate SHA-based directories', async () => {
      const actionV5 = `name: Checkout v5\nruns:\n  using: node20\n  main: index.js\n`
      const actionV6 = `name: Checkout v6\nruns:\n  using: node22\n  main: index.js\n`

      // v5: resolve + fetch
      mockGetCommit('sha-v5-abc')
      mockGetContent(actionV5)
      // v6: resolve + fetch
      mockGetCommit('sha-v6-def')
      mockGetContent(actionV6)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'actions',
            repo: 'checkout',
            ref: 'v5',
            uses: 'actions/checkout@v5'
          },
          {
            owner: 'actions',
            repo: 'checkout',
            ref: 'v6',
            uses: 'actions/checkout@v6'
          }
        ],
        tempDir
      )

      // Both versions are written
      expect(result.actionsWritten).toBe(2)
      expect(result.errors).toHaveLength(0)

      // v5 file
      const v5Path = path.join(
        tempDir,
        '.github',
        'actions',
        'external',
        'actions',
        'checkout',
        'sha-v5-abc',
        'action.yml'
      )
      expect(fs.existsSync(v5Path)).toBe(true)
      expect(fs.readFileSync(v5Path, 'utf8')).toBe(actionV5)

      // v6 file
      const v6Path = path.join(
        tempDir,
        '.github',
        'actions',
        'external',
        'actions',
        'checkout',
        'sha-v6-def',
        'action.yml'
      )
      expect(fs.existsSync(v6Path)).toBe(true)
      expect(fs.readFileSync(v6Path, 'utf8')).toBe(actionV6)

      // mapping.yaml should contain both versions
      const mappingPath = path.join(
        tempDir,
        '.github',
        'actions',
        'external',
        'mapping.yaml'
      )
      expect(fs.existsSync(mappingPath)).toBe(true)
      const mapping = yaml.parse(fs.readFileSync(mappingPath, 'utf8'))
      expect(mapping['actions/checkout']).toEqual({
        v5: 'sha-v5-abc',
        v6: 'sha-v6-def'
      })
    })

    it('writes different versions of same callable workflow to separate SHA-based directories', async () => {
      const workflowV1 = `name: CI v1\non:\n  workflow_call:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo v1\n`
      const workflowV2 = `name: CI v2\non:\n  workflow_call:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo v2\n`

      // v1: resolve + fetch
      mockGetCommit('wf-sha-v1')
      mockGetContent(workflowV1)
      // v2: resolve + fetch
      mockGetCommit('wf-sha-v2')
      mockGetContent(workflowV2)

      const writer = new FileWriter('test-token')
      const result = await writer.writeExternalDependencies(
        [
          {
            owner: 'org',
            repo: 'repo',
            actionPath: '.github/workflows/ci.yml',
            ref: 'v1',
            uses: 'org/repo/.github/workflows/ci.yml@v1'
          },
          {
            owner: 'org',
            repo: 'repo',
            actionPath: '.github/workflows/ci.yml',
            ref: 'v2',
            uses: 'org/repo/.github/workflows/ci.yml@v2'
          }
        ],
        tempDir
      )

      // Both versions are written
      expect(result.workflowsWritten).toBe(2)

      // v1 file
      const v1Path = path.join(
        tempDir,
        '.github',
        'workflows',
        'external',
        'org',
        'repo',
        'wf-sha-v1',
        '.github',
        'workflows',
        'ci.yml'
      )
      expect(fs.existsSync(v1Path)).toBe(true)
      expect(fs.readFileSync(v1Path, 'utf8')).toBe(workflowV1)

      // v2 file
      const v2Path = path.join(
        tempDir,
        '.github',
        'workflows',
        'external',
        'org',
        'repo',
        'wf-sha-v2',
        '.github',
        'workflows',
        'ci.yml'
      )
      expect(fs.existsSync(v2Path)).toBe(true)
      expect(fs.readFileSync(v2Path, 'utf8')).toBe(workflowV2)

      // workflow mapping.yaml should contain both versions
      const mappingPath = path.join(
        tempDir,
        '.github',
        'workflows',
        'external',
        'mapping.yaml'
      )
      expect(fs.existsSync(mappingPath)).toBe(true)
      const mapping = yaml.parse(fs.readFileSync(mappingPath, 'utf8'))
      expect(mapping['org/repo']).toEqual({
        v1: 'wf-sha-v1',
        v2: 'wf-sha-v2'
      })
    })

    it('generates mapping.yaml with multiple repos', async () => {
      const checkoutYml = `name: Checkout\nruns:\n  using: node20\n  main: index.js\n`
      const cacheYml = `name: Cache\nruns:\n  using: node20\n  main: index.js\n`

      mockGetCommit('checkout-sha')
      mockGetContent(checkoutYml)
      mockGetCommit('cache-sha')
      mockGetContent(cacheYml)

      const writer = new FileWriter('test-token')
      await writer.writeExternalDependencies(
        [
          {
            owner: 'actions',
            repo: 'checkout',
            ref: 'v4',
            uses: 'actions/checkout@v4'
          },
          {
            owner: 'actions',
            repo: 'cache',
            ref: 'v4',
            uses: 'actions/cache@v4'
          }
        ],
        tempDir
      )

      const mappingPath = path.join(
        tempDir,
        '.github',
        'actions',
        'external',
        'mapping.yaml'
      )
      const mapping = yaml.parse(fs.readFileSync(mappingPath, 'utf8'))
      expect(mapping['actions/checkout']).toEqual({ v4: 'checkout-sha' })
      expect(mapping['actions/cache']).toEqual({ v4: 'cache-sha' })
    })

    it('does not write mapping.yaml when no dependencies are written', async () => {
      // getCommit succeeds but action file not found
      mockGetCommit('sha999')
      github.mockOctokit.rest.repos.getContent
        .mockRejectedValueOnce(new Error('Not found'))
        .mockRejectedValueOnce(new Error('Not found'))

      const writer = new FileWriter('test-token')
      await writer.writeExternalDependencies(
        [
          {
            owner: 'actions',
            repo: 'cache',
            ref: 'v4',
            uses: 'actions/cache@v4'
          }
        ],
        tempDir
      )

      const mappingPath = path.join(
        tempDir,
        '.github',
        'actions',
        'external',
        'mapping.yaml'
      )
      expect(fs.existsSync(mappingPath)).toBe(false)
    })
  })
})
