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

// Mock @actions/core and @actions/github before importing FileWriter
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => github)

const { FileWriter } = await import('../src/file-writer.js')

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
    it('writes a composite action to the correct path', async () => {
      const actionYml = `name: Test\nruns:\n  using: node20\n  main: index.js\n`
      github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
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
      expect(result.workflowsWritten).toBe(0)
      expect(result.errors).toHaveLength(0)

      const expectedPath = path.join(
        tempDir,
        '.github',
        'actions',
        'external',
        'actions',
        'cache',
        'action.yml'
      )
      expect(fs.existsSync(expectedPath)).toBe(true)
      expect(fs.readFileSync(expectedPath, 'utf8')).toBe(actionYml)
    })

    it('writes an action with actionPath to the correct subdirectory', async () => {
      const actionYml = `name: Setup\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n`
      github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: { content: Buffer.from(actionYml).toString('base64') }
      })

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
        '.github',
        'setup',
        'action.yml'
      )
      expect(fs.existsSync(expectedPath)).toBe(true)
    })

    it('writes a callable workflow to the correct path', async () => {
      const workflowYml = `name: CI\non:\n  workflow_call:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`
      github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: { content: Buffer.from(workflowYml).toString('base64') }
      })

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
        '.github',
        'workflows',
        'ci.yml'
      )
      expect(fs.existsSync(expectedPath)).toBe(true)
      expect(fs.readFileSync(expectedPath, 'utf8')).toBe(workflowYml)
    })

    it('deduplicates dependencies by key', async () => {
      const actionYml = `name: Test\nruns:\n  using: node20\n  main: index.js\n`
      github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: { content: Buffer.from(actionYml).toString('base64') }
      })

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
      // Only one getContent call should be made
      expect(
        github.mockOctokit.rest.repos.getContent
      ).toHaveBeenCalledTimes(1)
    })

    it('handles API errors gracefully', async () => {
      github.mockOctokit.rest.repos.getContent.mockRejectedValue(
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

      // fetchActionFile returns null when both action.yml and action.yaml fail,
      // so writeCompositeAction returns null (not written, not an error)
      expect(result.actionsWritten).toBe(0)
      expect(result.errors).toHaveLength(0)
    })

    it('returns false when action.yml and action.yaml both not found', async () => {
      // Both action.yml and action.yaml fail
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

      // First call: fetch outer action (action.yml)
      github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: { content: Buffer.from(outerAction).toString('base64') }
      })
      // Second call: fetch inner action (actions/cache action.yml)
      github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: { content: Buffer.from(innerAction).toString('base64') }
      })

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

      // Both files should exist
      expect(
        fs.existsSync(
          path.join(
            tempDir,
            '.github',
            'actions',
            'external',
            'some-org',
            'setup-action',
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
            'action.yml'
          )
        )
      ).toBe(true)
    })

    it('recursively downloads nested workflow job-level callable workflows', async () => {
      const workflowYml = `name: CI\non:\n  workflow_call:\njobs:\n  inner:\n    uses: other-org/repo/.github/workflows/build.yml@v1\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`
      const innerWorkflowYml = `name: Build\non:\n  workflow_call:\njobs:\n  compile:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo build\n`

      // First call: fetch outer workflow
      github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: { content: Buffer.from(workflowYml).toString('base64') }
      })
      // Second call: fetch inner workflow
      github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: { content: Buffer.from(innerWorkflowYml).toString('base64') }
      })

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

      github.mockOctokit.rest.repos.getContent
        .mockResolvedValueOnce({
          data: { content: Buffer.from(actionA).toString('base64') }
        })
        .mockResolvedValueOnce({
          data: { content: Buffer.from(actionB).toString('base64') }
        })

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
      github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
        data: { content: Buffer.from(invalidYaml).toString('base64') }
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

      // Should still write the file, just not recurse
      expect(result.actionsWritten).toBe(1)
    })

    it('skips local ./ references in nested content', async () => {
      const actionYml = `name: Test\nruns:\n  using: composite\n  steps:\n    - uses: ./local-step\n    - uses: actions/checkout@v4\n`
      const checkoutYml = `name: Checkout\nruns:\n  using: node20\n  main: index.js\n`

      github.mockOctokit.rest.repos.getContent
        .mockResolvedValueOnce({
          data: { content: Buffer.from(actionYml).toString('base64') }
        })
        .mockResolvedValueOnce({
          data: { content: Buffer.from(checkoutYml).toString('base64') }
        })

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

      github.mockOctokit.rest.repos.getContent
        .mockResolvedValueOnce({
          data: { content: Buffer.from(actionYml1).toString('base64') }
        })
        .mockResolvedValueOnce({
          data: { content: Buffer.from(actionYml2).toString('base64') }
        })

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

      github.mockOctokit.rest.repos.getContent
        .mockResolvedValueOnce({
          data: { content: Buffer.from(workflowYml).toString('base64') }
        })
        .mockResolvedValueOnce({
          data: { content: Buffer.from(checkoutYml).toString('base64') }
        })

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
  })
})
