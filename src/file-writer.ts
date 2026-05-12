import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'yaml'
import * as core from '@actions/core'
import { ActionDependency } from './workflow-parser.js'
import { OctokitProvider } from './octokit-provider.js'

export interface WriteResult {
  actionsWritten: number
  workflowsWritten: number
  errors: string[]
}

export class FileWriter {
  private octokitProvider: OctokitProvider
  private processedKeys: Set<string> = new Set()

  constructor(token: string, publicGitHubToken?: string) {
    this.octokitProvider = new OctokitProvider({
      token,
      publicGitHubToken
    })
  }

  async writeExternalDependencies(
    dependencies: ActionDependency[],
    repoRoot: string
  ): Promise<WriteResult> {
    const result: WriteResult = {
      actionsWritten: 0,
      workflowsWritten: 0,
      errors: []
    }

    for (const dep of dependencies) {
      const key = `${dep.owner}/${dep.repo}${dep.actionPath ? '/' + dep.actionPath : ''}@${dep.ref}`
      if (this.processedKeys.has(key)) continue
      this.processedKeys.add(key)

      try {
        if (this.isCallableWorkflow(dep)) {
          const nestedResult = await this.writeCallableWorkflow(dep, repoRoot)
          result.workflowsWritten++
          if (nestedResult) {
            result.actionsWritten += nestedResult.actionsWritten
            result.workflowsWritten += nestedResult.workflowsWritten
            result.errors.push(...nestedResult.errors)
          }
        } else {
          const nestedResult = await this.writeCompositeAction(dep, repoRoot)
          if (nestedResult) {
            result.actionsWritten++
            result.actionsWritten += nestedResult.actionsWritten
            result.workflowsWritten += nestedResult.workflowsWritten
            result.errors.push(...nestedResult.errors)
          }
        }
      } catch (error) {
        const msg = `Failed to download ${key}: ${error}`
        core.warning(msg)
        result.errors.push(msg)
      }
    }

    return result
  }

  private isCallableWorkflow(dep: ActionDependency): boolean {
    return /^[^/]+\/[^/]+\/.+\.ya?ml@.+$/.test(dep.uses)
  }

  private async writeCompositeAction(
    dep: ActionDependency,
    repoRoot: string
  ): Promise<WriteResult | null> {
    const basePath = dep.actionPath
      ? `${dep.owner}/${dep.repo}/${dep.actionPath}`
      : `${dep.owner}/${dep.repo}`
    const targetDir = path.join(
      repoRoot,
      '.github',
      'actions',
      'external',
      basePath
    )

    const content = await this.fetchActionFile(dep)
    if (!content) return null

    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'action.yml'), content, 'utf8')
    core.info(
      `Downloaded: ${dep.uses} -> ${path.relative(repoRoot, targetDir)}/action.yml`
    )

    return await this.processNestedDependencies(content, repoRoot)
  }

  private async writeCallableWorkflow(
    dep: ActionDependency,
    repoRoot: string
  ): Promise<WriteResult | null> {
    const match = dep.uses.match(/^[^/]+\/[^/]+\/(.+\.ya?ml)@.+$/)
    if (!match) return null

    const workflowPath = match[1]
    const targetPath = path.join(
      repoRoot,
      '.github',
      'workflows',
      'external',
      dep.owner,
      dep.repo,
      workflowPath
    )

    const octokit = await this.octokitProvider.getOctokitForRepo(
      dep.owner,
      dep.repo
    )
    const { data } = await octokit.rest.repos.getContent({
      owner: dep.owner,
      repo: dep.repo,
      path: workflowPath,
      ref: dep.ref
    })

    if (!('content' in data)) return null
    const content = Buffer.from(
      (data as { content: string }).content,
      'base64'
    ).toString('utf8')

    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.writeFileSync(targetPath, content, 'utf8')
    core.info(
      `Downloaded: ${dep.uses} -> ${path.relative(repoRoot, targetPath)}`
    )

    return await this.processNestedDependencies(content, repoRoot)
  }

  private async fetchActionFile(
    dep: ActionDependency
  ): Promise<string | null> {
    const octokit = await this.octokitProvider.getOctokitForRepo(
      dep.owner,
      dep.repo
    )
    const basePath = dep.actionPath ? `${dep.actionPath}/` : ''

    for (const filename of ['action.yml', 'action.yaml']) {
      try {
        const { data } = await octokit.rest.repos.getContent({
          owner: dep.owner,
          repo: dep.repo,
          path: `${basePath}${filename}`,
          ref: dep.ref
        })
        if ('content' in data) {
          return Buffer.from(
            (data as { content: string }).content,
            'base64'
          ).toString('utf8')
        }
      } catch {
        // Try next filename
      }
    }
    return null
  }

  private async processNestedDependencies(
    yamlContent: string,
    repoRoot: string
  ): Promise<WriteResult> {
    const emptyResult: WriteResult = {
      actionsWritten: 0,
      workflowsWritten: 0,
      errors: []
    }

    let parsed: Record<string, unknown>
    try {
      parsed = yaml.parse(yamlContent, { merge: true })
    } catch {
      return emptyResult
    }
    if (!parsed) return emptyResult

    const nestedDeps: ActionDependency[] = []

    const runs = parsed.runs as
      | { steps?: Array<{ uses?: string }> }
      | undefined
    if (runs?.steps) {
      for (const step of runs.steps) {
        if (step.uses && !step.uses.startsWith('./')) {
          const dep = this.parseUsesString(step.uses)
          if (dep) nestedDeps.push(dep)
        }
      }
    }

    const jobs = parsed.jobs as
      | Record<
          string,
          { uses?: string; steps?: Array<{ uses?: string }> }
        >
      | undefined
    if (jobs) {
      for (const jobName in jobs) {
        const job = jobs[jobName]
        if (
          job.uses &&
          typeof job.uses === 'string' &&
          !job.uses.startsWith('./')
        ) {
          const dep = this.parseUsesString(job.uses)
          if (dep) nestedDeps.push(dep)
        }
        if (job.steps) {
          for (const step of job.steps) {
            if (step.uses && !step.uses.startsWith('./')) {
              const dep = this.parseUsesString(step.uses)
              if (dep) nestedDeps.push(dep)
            }
          }
        }
      }
    }

    if (nestedDeps.length > 0) {
      return await this.writeExternalDependencies(nestedDeps, repoRoot)
    }

    return emptyResult
  }

  private parseUsesString(uses: string): ActionDependency | null {
    const match = uses.match(/^([^/]+)\/([^/@]+)(?:\/([^@]+))?@(.+)$/)
    if (!match) return null
    return {
      owner: match[1],
      repo: match[2],
      actionPath: match[3],
      ref: match[4],
      uses
    }
  }
}
