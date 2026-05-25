import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftStatus } from '../../../../src/types/draft'
import { createGitHubProvider } from '../../../../src/utils/providers/github'

const mockRepositoryApi = vi.fn()
const mockUserApi = vi.fn()
const mockSignCommit = vi.fn()
const mockLoggerWarn = vi.hoisted(() => vi.fn())

vi.mock('ofetch', () => {
  const mockedOfetch = Object.assign(
    vi.fn((request: string, options?: Record<string, unknown>) => mockSignCommit(request, options)),
    {
      create: vi.fn((options: { baseURL: string }) => {
        return options.baseURL.includes('/repos/') ? mockRepositoryApi : mockUserApi
      }),
    },
  )

  return { ofetch: mockedOfetch }
})

vi.mock('consola', () => ({
  consola: {
    withTag: vi.fn(() => ({
      error: vi.fn(),
      warn: mockLoggerWarn,
    })),
  },
}))

const baseGitOptions = {
  provider: 'github' as const,
  owner: 'team-communication',
  repo: 'numberly-2026',
  branch: 'dev',
  rootDir: '',
  authorName: 'Test Author',
  authorEmail: 'author@example.com',
  token: 'ghp_test-token',
  instanceUrl: 'https://github.com',
} as const

function createRepositoryApiHandler() {
  return (request: string, options?: { method?: string, body?: string }) => {
    if (request === '/git/refs/heads/dev' && options === undefined) {
      return Promise.resolve({ object: { sha: 'parent-sha' } })
    }
    if (request === '/git/commits/parent-sha' && options === undefined) {
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
    if (request === '/git/refs/heads/dev' && options?.method === 'PATCH') {
      return Promise.resolve({})
    }

    return Promise.reject(new Error(`Unexpected request: ${request} ${options?.method ?? ''}`))
  }
}

describe('createGitHubProvider / commitFiles', () => {
  beforeEach(() => {
    mockRepositoryApi.mockImplementation(createRepositoryApiHandler())
    mockUserApi.mockResolvedValue({ login: 'test-user', email: 'author@example.com', name: 'Test Author' })
    mockSignCommit.mockResolvedValue({ signature: 'signed-commit' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('continues with an unsigned commit when best-effort signing fails', async () => {
    mockSignCommit.mockRejectedValueOnce(new Error('bad private key'))

    const provider = createGitHubProvider({ ...baseGitOptions, signingEnabled: true })

    const result = await provider.commitFiles(
      [{ path: 'content/index.md', status: DraftStatus.Updated, content: '# Hello\n', encoding: 'utf-8' }],
      'docs: update content',
    )

    expect(result).toEqual({
      success: true,
      commitSha: 'new-commit-sha',
      url: 'https://github.com/team-communication/numberly-2026/commit/new-commit-sha',
    })
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Failed to sign commit; publishing unsigned commit instead.',
      expect.any(Error),
    )

    expect(mockSignCommit).toHaveBeenCalledWith('/__nuxt_studio/git/sign-commit', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        tree: 'tree-sha',
        parent: 'parent-sha',
        name: 'Test Author',
        email: 'author@example.com',
        message: expect.stringContaining('docs: update content'),
      }),
    }))

    const commitCall = mockRepositoryApi.mock.calls.find(([request, options]) => {
      return request === '/git/commits' && options?.method === 'POST'
    })

    expect(commitCall).toBeDefined()
    const commitBody = JSON.parse(commitCall![1].body) as Record<string, unknown>
    expect(commitBody.signature).toBeUndefined()
    expect(commitBody).toMatchObject({
      message: expect.stringContaining('docs: update content'),
      tree: 'tree-sha',
      parents: ['parent-sha'],
    })

    expect(mockRepositoryApi).toHaveBeenCalledWith('/git/refs/heads/dev', {
      method: 'PATCH',
      body: JSON.stringify({ sha: 'new-commit-sha' }),
    })
  })
})
