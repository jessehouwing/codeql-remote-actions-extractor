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

// Internal mapping entry: owner/repo -> { ref -> sha }
interface MappingEntries {
  [ownerRepo: string]: { [ref: string]: string }
}

export class FileWriter {
  private octokitProvider: OctokitProvider
  private processedKeys: Set<string> = new Set()
  private actionMappings: MappingEntries = {}
  private workflowMappings: MappingEntries = {}
  private legacyActionShas: Map<string, string> = new Map()
  private legacyWorkflowShas: Map<string, string> = new Map()
  private mode: string

  constructor(token: string, publicGitHubToken?: string, mode?: string) {
    this.octokitProvider = new OctokitProvider({
      token,
      publicGitHubToken
    })
    this.mode = mode || ''
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
          const writeResult = await this.writeCallableWorkflow(dep, repoRoot)
          if (writeResult) {
            result.workflowsWritten++
            result.actionsWritten += writeResult.actionsWritten
            result.workflowsWritten += writeResult.workflowsWritten
            result.errors.push(...writeResult.errors)
          }
        } else {
          const writeResult = await this.writeCompositeAction(dep, repoRoot)
          if (writeResult) {
            result.actionsWritten++
            result.actionsWritten += writeResult.actionsWritten
            result.workflowsWritten += writeResult.workflowsWritten
            result.errors.push(...writeResult.errors)
          }
        }
      } catch (error) {
        const msg = `Failed to download ${key}: ${error}`
        core.warning(msg)
        result.errors.push(msg)
      }
    }

    // Write mapping.yaml files
    this.writeMappingFiles(repoRoot)

    return result
  }

  private isCallableWorkflow(dep: ActionDependency): boolean {
    return /^[^/]+\/[^/]+\/.+\.ya?ml@.+$/.test(dep.uses)
  }

  private async resolveRefToSha(dep: ActionDependency): Promise<string> {
    const octokit = await this.octokitProvider.getOctokitForRepo(
      dep.owner,
      dep.repo
    )
    const { data } = await octokit.rest.repos.getCommit({
      owner: dep.owner,
      repo: dep.repo,
      ref: dep.ref
    })
    return data.sha
  }

  private async writeCompositeAction(
    dep: ActionDependency,
    repoRoot: string
  ): Promise<WriteResult | null> {
    const sha = await this.resolveRefToSha(dep)
    const ownerRepo = `${dep.owner}/${dep.repo}`

    // Build SHA-based path: {owner}/{repo}/{sha}/[actionPath/]
    const basePath = dep.actionPath
      ? `${ownerRepo}/${sha}/${dep.actionPath}`
      : `${ownerRepo}/${sha}`
    const targetDir = path.join(
      repoRoot,
      '.github',
      'actions',
      'external',
      basePath
    )
    const targetFile = path.join(targetDir, 'action.yml')

    const content = await this.fetchActionFile(dep)
    if (!content) return null

    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(targetFile, content, 'utf8')
    core.info(
      `Downloaded: ${dep.uses} -> ${path.relative(repoRoot, targetDir)}/action.yml`
    )

    // Record mapping entry
    if (!this.actionMappings[ownerRepo]) {
      this.actionMappings[ownerRepo] = {}
    }
    this.actionMappings[ownerRepo][dep.ref] = sha

    // Legacy mode: also write to SHA-less path for the first encountered version
    if (this.mode === 'legacy') {
      const legacyKey = dep.actionPath
        ? `${ownerRepo}/${dep.actionPath}`
        : ownerRepo
      const existingSha = this.legacyActionShas.get(legacyKey)
      if (existingSha === undefined) {
        // First encounter: write to legacy (SHA-less) path
        this.legacyActionShas.set(legacyKey, sha)
        const legacyDir = path.join(
          repoRoot,
          '.github',
          'actions',
          'external',
          dep.actionPath ? `${ownerRepo}/${dep.actionPath}` : ownerRepo
        )
        fs.mkdirSync(legacyDir, { recursive: true })
        fs.writeFileSync(path.join(legacyDir, 'action.yml'), content, 'utf8')
        core.info(
          `Legacy: wrote ${dep.uses} -> ${path.relative(repoRoot, legacyDir)}/action.yml`
        )
      } else if (existingSha !== sha) {
        core.warning(
          `Legacy mode: ${legacyKey} was already written at SHA ${existingSha}, but a different version (${sha}) was also referenced. The SHA-less path retains the first encountered version.`
        )
      }
    }

    return await this.processNestedDependencies(content, repoRoot)
  }

  private async writeCallableWorkflow(
    dep: ActionDependency,
    repoRoot: string
  ): Promise<WriteResult | null> {
    const match = dep.uses.match(/^[^/]+\/[^/]+\/(.+\.ya?ml)@.+$/)
    if (!match) return null

    const sha = await this.resolveRefToSha(dep)
    const ownerRepo = `${dep.owner}/${dep.repo}`
    const workflowPath = match[1]

    // Build SHA-based path: {owner}/{repo}/{sha}/{workflowPath}
    const targetPath = path.join(
      repoRoot,
      '.github',
      'workflows',
      'external',
      dep.owner,
      dep.repo,
      sha,
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

    // Record mapping entry
    if (!this.workflowMappings[ownerRepo]) {
      this.workflowMappings[ownerRepo] = {}
    }
    this.workflowMappings[ownerRepo][dep.ref] = sha

    // Legacy mode: also write to SHA-less path for the first encountered version
    if (this.mode === 'legacy') {
      const legacyKey = `${ownerRepo}/${workflowPath}`
      const existingSha = this.legacyWorkflowShas.get(legacyKey)
      if (existingSha === undefined) {
        this.legacyWorkflowShas.set(legacyKey, sha)
        const legacyPath = path.join(
          repoRoot,
          '.github',
          'workflows',
          'external',
          dep.owner,
          dep.repo,
          workflowPath
        )
        fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
        fs.writeFileSync(legacyPath, content, 'utf8')
        core.info(
          `Legacy: wrote ${dep.uses} -> ${path.relative(repoRoot, legacyPath)}`
        )
      } else if (existingSha !== sha) {
        core.warning(
          `Legacy mode: ${legacyKey} was already written at SHA ${existingSha}, but a different version (${sha}) was also referenced. The SHA-less path retains the first encountered version.`
        )
      }
    }

    return await this.processNestedDependencies(content, repoRoot)
  }

  private writeMappingFiles(repoRoot: string): void {
    if (Object.keys(this.actionMappings).length > 0) {
      const mappingPath = path.join(
        repoRoot,
        '.github',
        'actions',
        'external',
        'mapping.yaml'
      )
      fs.mkdirSync(path.dirname(mappingPath), { recursive: true })
      fs.writeFileSync(mappingPath, yaml.stringify(this.actionMappings), 'utf8')
      core.info(
        `Wrote action mapping file: ${path.relative(repoRoot, mappingPath)}`
      )
    }

    if (Object.keys(this.workflowMappings).length > 0) {
      const mappingPath = path.join(
        repoRoot,
        '.github',
        'workflows',
        'external',
        'mapping.yaml'
      )
      fs.mkdirSync(path.dirname(mappingPath), { recursive: true })
      fs.writeFileSync(
        mappingPath,
        yaml.stringify(this.workflowMappings),
        'utf8'
      )
      core.info(
        `Wrote workflow mapping file: ${path.relative(repoRoot, mappingPath)}`
      )
    }
  }

  private async fetchActionFile(dep: ActionDependency): Promise<string | null> {
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

    const runs = parsed.runs as { steps?: Array<{ uses?: string }> } | undefined
    if (runs?.steps) {
      for (const step of runs.steps) {
        if (step.uses && !step.uses.startsWith('./')) {
          const dep = this.parseUsesString(step.uses)
          if (dep) nestedDeps.push(dep)
        }
      }
    }

    const jobs = parsed.jobs as
      | Record<string, { uses?: string; steps?: Array<{ uses?: string }> }>
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
