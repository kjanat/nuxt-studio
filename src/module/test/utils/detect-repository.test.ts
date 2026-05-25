import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectRepository } from '../../src/utils/detect-repository'

const DETECTION_ENV_KEYS = [
  'STUDIO_REPO_URL',
  'STUDIO_REPO_BRANCH',
  'STUDIO_REPO_ROOT_DIR',
  'VERCEL_GIT_PROVIDER',
  'VERCEL_GIT_REPO_OWNER',
  'VERCEL_GIT_REPO_SLUG',
  'VERCEL_GIT_COMMIT_REF',
  'NETLIFY',
  'REPOSITORY_URL',
  'BRANCH',
  'GITHUB_ACTIONS',
  'GITHUB_REPOSITORY',
  'GITHUB_REF_NAME',
  'GITLAB_CI',
  'CI_PROJECT_NAMESPACE',
  'CI_PROJECT_NAME',
  'CI_COMMIT_BRANCH',
  'CI_SERVER_URL',
  'WORKERS_CI',
  'WORKERS_CI_BRANCH',
  'CF_PAGES',
  'CF_PAGES_BRANCH',
] as const

describe('detectRepository', () => {
  let originalEnv: Record<string, string | undefined>
  let roots: string[]

  beforeEach(() => {
    originalEnv = {}
    roots = []

    for (const key of DETECTION_ENV_KEYS) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of DETECTION_ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }

    for (const root of roots) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function createRoot() {
    const root = mkdtempSync(join(tmpdir(), 'nuxt-studio-detect-repository-'))
    roots.push(root)
    return root
  }

  function writePackageRepository(root: string) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ repository: 'github:nuxt/studio' }))
  }

  it('detects Cloudflare Workers branch when WORKERS_CI is present', () => {
    const root = createRoot()
    writePackageRepository(root)
    process.env.WORKERS_CI = '1'
    process.env.WORKERS_CI_BRANCH = 'production'

    expect(detectRepository(root)).toEqual({
      provider: 'github',
      owner: 'nuxt',
      repo: 'studio',
      branch: 'production',
    })
  })

  it('ignores WORKERS_CI_BRANCH without WORKERS_CI', () => {
    const root = createRoot()
    process.env.WORKERS_CI_BRANCH = 'local-branch'

    expect(detectRepository(root)).toBeUndefined()
  })

  it('does not override user-defined branch with Cloudflare Workers branch', () => {
    const root = createRoot()
    process.env.STUDIO_REPO_BRANCH = 'configured-branch'
    process.env.WORKERS_CI = '1'
    process.env.WORKERS_CI_BRANCH = 'production'

    expect(detectRepository(root)).toEqual({
      branch: 'configured-branch',
    })
  })

  it('detects Cloudflare Pages branch only when CF_PAGES is present', () => {
    const root = createRoot()
    writePackageRepository(root)
    process.env.CF_PAGES = '1'
    process.env.CF_PAGES_BRANCH = 'pages-branch'

    expect(detectRepository(root)).toEqual({
      provider: 'github',
      owner: 'nuxt',
      repo: 'studio',
      branch: 'pages-branch',
    })
  })
})
