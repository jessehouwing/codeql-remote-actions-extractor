/**
 * Unit tests for the action's main functionality, src/main.ts
 */
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'
import * as github from '../__fixtures__/github.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Mocks should be declared before the module being tested is imported.
jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => github)

// The module being tested should be imported dynamically.
const { run } = await import('../src/main.js')

describe('main.ts', () => {
  let tempDir: string

  beforeEach(() => {
    jest.clearAllMocks()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-test-'))

    // Set default inputs
    core.getInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        token: 'test-token',
        'workflow-directory': tempDir,
        'public-github-token': ''
      }
      return inputs[name] || ''
    })

    // Default: local repo check succeeds
    github.mockOctokit.rest.repos.get.mockResolvedValue({ data: {} })
  })

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
    delete process.env.GITHUB_WORKSPACE
  })

  it('Downloads composite actions to correct paths', async () => {
    const workflowContent = `
name: Test Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
    fs.writeFileSync(path.join(tempDir, 'test.yml'), workflowContent)

    const actionYml = `name: Checkout\nruns:\n  using: node20\n  main: index.js\n`
    // WorkflowParser fetchRemoteActionFile may call getContent
    github.mockOctokit.rest.repos.getContent.mockResolvedValue({
      data: { content: Buffer.from(actionYml).toString('base64') }
    })
    // FileWriter resolves ref to SHA
    github.mockOctokit.rest.repos.getCommit.mockResolvedValue({
      data: { sha: 'abc123' }
    })

    // Set GITHUB_WORKSPACE to tempDir so FileWriter writes there
    process.env.GITHUB_WORKSPACE = tempDir

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('actions-count', 1)
    expect(core.setOutput).toHaveBeenCalledWith('workflows-count', 0)
    expect(core.setFailed).not.toHaveBeenCalled()

    const expectedPath = path.join(
      tempDir,
      '.github',
      'actions',
      'external',
      'actions',
      'checkout',
      'abc123',
      'action.yml'
    )
    expect(fs.existsSync(expectedPath)).toBe(true)
  })

  it('Handles empty workflow directory', async () => {
    await run()

    expect(core.info).toHaveBeenCalledWith('No remote dependencies found')
    expect(core.setOutput).toHaveBeenCalledWith('actions-count', 0)
    expect(core.setOutput).toHaveBeenCalledWith('workflows-count', 0)
  })

  it('Sets failed status on error', async () => {
    core.getInput.mockImplementation(() => {
      throw new Error('Input error')
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith('Input error')
  })

  it('Filters out local ./ references', async () => {
    const workflowContent = `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./local-action
`
    fs.writeFileSync(path.join(tempDir, 'test.yml'), workflowContent)

    await run()

    expect(core.info).toHaveBeenCalledWith('No remote dependencies found')
    expect(core.setOutput).toHaveBeenCalledWith('actions-count', 0)
    expect(core.setOutput).toHaveBeenCalledWith('workflows-count', 0)
  })

  it('Downloads multiple dependencies from multiple workflow files', async () => {
    const workflow1 = `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
`
    const workflow2 = `
name: Deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`
    fs.writeFileSync(path.join(tempDir, 'ci.yml'), workflow1)
    fs.writeFileSync(path.join(tempDir, 'deploy.yml'), workflow2)

    const actionYml = `name: Test\nruns:\n  using: node20\n  main: index.js\n`
    // actions/checkout
    github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: { content: Buffer.from(actionYml).toString('base64') }
    })
    // actions/setup-node
    github.mockOctokit.rest.repos.getContent.mockResolvedValueOnce({
      data: { content: Buffer.from(actionYml).toString('base64') }
    })
    // FileWriter resolves refs to SHAs
    github.mockOctokit.rest.repos.getCommit.mockResolvedValue({
      data: { sha: 'sha111' }
    })

    process.env.GITHUB_WORKSPACE = tempDir
    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('Handles download failures without failing the action', async () => {
    const workflowContent = `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: private-org/secret-action@v1
`
    fs.writeFileSync(path.join(tempDir, 'test.yml'), workflowContent)

    github.mockOctokit.rest.repos.getContent.mockRejectedValue(
      new Error('Not found')
    )
    github.mockOctokit.rest.repos.getCommit.mockRejectedValue(
      new Error('Not found')
    )

    process.env.GITHUB_WORKSPACE = tempDir
    await run()

    // Action should not fail - missing actions produce zero written count
    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('actions-count', 0)
  })
})
