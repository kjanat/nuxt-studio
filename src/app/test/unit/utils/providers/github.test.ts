import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitOptions } from '../../../../src/types/git'
import { DraftStatus } from '../../../../src/types/draft'
import { createGitHubProvider } from '../../../../src/utils/providers/github'

function createGitHubApiHandler() {
  return (
    request: string,
    options?: { method?: string, body?: string },
  ) => {
    if (request === '/git/refs/heads/main' && !options?.method) {
      return Promise.resolve({ object: { sha: 'base-commit-sha' } })
    }
    if (request === '/git/commits/base-commit-sha' && !options?.method) {
      return Promise.resolve({ tree: { sha: 'base-tree-sha' } })
    }
    if (request === '/git/blobs' && options?.method === 'POST') {
      return Promise.resolve({ sha: 'blob-sha' })
    }
    if (request === '/git/trees' && options?.method === 'POST') {
      return Promise.resolve({ sha: 'tree-sha' })
    }
    if (request === '/git/commits' && options?.method === 'POST') {
      return Promise.resolve({ sha: 'new-commit-sha' })
    }
    if (request === '/git/refs/heads/main' && options?.method === 'PATCH') {
      return Promise.resolve({})
    }
    return Promise.reject(new Error(`Unexpected request: ${request} ${options?.method ?? ''}`))
  }
}

const mock$api = vi.fn(createGitHubApiHandler())

vi.mock('ofetch', () => ({
  ofetch: {
    create: vi.fn(() => mock$api),
  },
}))

const baseGitOptions: GitOptions = {
  provider: 'github',
  owner: 'nuxt-content',
  repo: 'nuxt-studio',
  branch: 'main',
  rootDir: '',
  authorName: 'Studio User',
  authorEmail: 'user@example.com',
  token: 'gho-test-token',
}

const file = {
  path: 'content/index.md',
  status: DraftStatus.Updated,
  content: '# Hello\n',
  encoding: 'utf-8' as const,
}

function getCommitBody() {
  const commitCall = mock$api.mock.calls.find(([request, options]) => {
    return request === '/git/commits' && options?.method === 'POST'
  })
  if (!commitCall) {
    throw new Error('Expected GitHub commit request')
  }
  return JSON.parse(commitCall[1]!.body!) as { message: string }
}

describe('createGitHubProvider / commitFiles', () => {
  beforeEach(() => {
    mock$api.mockImplementation(createGitHubApiHandler())
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('adds the Nuxt Studio co-author trailer by default', async () => {
    const provider = createGitHubProvider({ ...baseGitOptions })

    await provider.commitFiles([file], 'Update content')

    expect(getCommitBody().message).toBe(
      'Update content\n\nCo-authored-by: Nuxt Studio <noreply@nuxt.studio>',
    )
  })

  it('omits the Nuxt Studio co-author trailer when disabled', async () => {
    const provider = createGitHubProvider({
      ...baseGitOptions,
      coAuthorCredits: false,
    })

    await provider.commitFiles([file], 'Update content')

    expect(getCommitBody().message).toBe('Update content')
  })
})
