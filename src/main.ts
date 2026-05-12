import * as core from '@actions/core'
import { WorkflowParser } from './workflow-parser.js'
import { FileWriter } from './file-writer.js'

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const token = core.getInput('token', { required: true })
    const workflowDirectory = core.getInput('workflow-directory', {
      required: true
    })
    const publicGitHubToken = core.getInput('public-github-token')
    const mode = core.getInput('mode')

    const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd()

    core.info(`Scanning workflow directory: ${workflowDirectory}`)

    // Step 1: Parse workflows to discover all remote dependencies
    const parser = new WorkflowParser(token, publicGitHubToken || undefined)
    const { actionDependencies } = await parser.parseWorkflowDirectory(
      workflowDirectory,
      repoRoot
    )

    // Step 2: Filter to remote-only (exclude local ./ references)
    const remoteDeps = actionDependencies.filter(
      (d) => !d.uses.startsWith('./')
    )
    core.info(`Found ${remoteDeps.length} remote dependencies to download`)

    if (remoteDeps.length === 0) {
      core.info('No remote dependencies found')
      core.setOutput('actions-count', 0)
      core.setOutput('workflows-count', 0)
      return
    }

    // Step 3: Download and write to expected directories
    const writer = new FileWriter(token, publicGitHubToken || undefined, mode)
    const result = await writer.writeExternalDependencies(remoteDeps, repoRoot)

    core.info(
      `Downloaded ${result.actionsWritten} composite actions to .github/actions/external/`
    )
    core.info(
      `Downloaded ${result.workflowsWritten} callable workflows to .github/workflows/external/`
    )

    if (result.errors.length > 0) {
      core.warning(`${result.errors.length} dependencies failed to download`)
    }

    core.setOutput('actions-count', result.actionsWritten)
    core.setOutput('workflows-count', result.workflowsWritten)
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
