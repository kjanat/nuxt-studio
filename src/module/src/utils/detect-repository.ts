import { defu } from 'defu';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/**
 * Structural shape of the detected repository tuple. Mirrors the union of
 * `GitHubRepositoryOptions` and `GitLabRepositoryOptions` declared in `module.ts`
 * but kept inline here to avoid a circular import. The call site in `module.ts`
 * merges this into the user's `options.repository` via `defu`, so structural
 * compatibility is what matters, not nominal identity.
 */
interface DetectedRepository {
	provider?: 'github' | 'gitlab';
	owner?: string;
	repo?: string;
	branch?: string;
	rootDir?: string;
	private?: boolean;
	instanceUrl?: string;
}

interface ParsedGitUrl {
	provider: 'github' | 'gitlab';
	owner: string;
	repo: string;
	instanceUrl?: string;
}

/**
 * Parse a git remote URL into a structured repository descriptor.
 *
 * Supported input forms:
 *   https://github.com/owner/repo(.git)?
 *   git@github.com:owner/repo(.git)?
 *   ssh://git@github.com[:port]/owner/repo(.git)?
 *   github:owner/repo   /   gitlab:owner/repo   (npm shorthand)
 *   owner/repo                                  (npm bare shorthand, treated as github)
 *
 * For self-hosted instances (e.g. `git@gitlab.example.com:foo/bar.git`) the
 * provider is inferred from the host substring ("github" / "gitlab"). Hosts
 * without those substrings (e.g. `code.acme.corp`) return null — the user is
 * expected to supply `provider` and `instanceUrl` explicitly in `nuxt.config.ts`
 * in that case.
 */
function parseGitUrl(input: string): ParsedGitUrl | null {
	const cleaned = input.trim().replace(/\.git\/?$/, '');
	if (!cleaned) return null;

	// npm shorthand with explicit provider: "github:owner/repo", "gitlab:owner/repo"
	const namedShorthand = cleaned.match(/^(github|gitlab):([^/]+)\/(.+)$/);
	if (namedShorthand) {
		const [, provider, owner, repo] = namedShorthand;
		if (!owner || !repo) return null;
		return { provider: provider === 'gitlab' ? 'gitlab' : 'github', owner, repo };
	}

	// Bare npm shorthand: "owner/repo" — npm defaults this to github
	if (/^[^/:@\s]+\/[^/:@\s]+$/.test(cleaned)) {
		const parts = cleaned.split('/');
		const owner = parts[0];
		const repo = parts[1];
		if (!owner || !repo) return null;
		return { provider: 'github', owner, repo };
	}

	// Full URL: https://, ssh://, or user@host:path
	// Regex captures: host, owner, repo
	const fullUrl = cleaned.match(/^(?:[a-z]+:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?[:/]([^/\s]+)\/([^/\s]+)$/i);
	if (!fullUrl) return null;

	const host = fullUrl[1];
	const owner = fullUrl[2];
	const repo = fullUrl[3];
	if (!host || !owner || !repo) return null;

	const provider: 'github' | 'gitlab' | null = host.includes('gitlab')
		? 'gitlab'
		: host.includes('github')
		? 'github'
		: null;
	if (!provider) return null;

	const canonicalHost = provider === 'github' ? 'github.com' : 'gitlab.com';
	const isCanonical = host === canonicalHost;

	return {
		provider,
		owner,
		repo,
		...(isCanonical ? {} : { instanceUrl: `https://${host}` }),
	};
}

/**
 * Read repository info from environment variables.
 *
 * Order within this layer:
 *   1. `STUDIO_REPO_URL` / `STUDIO_REPO_BRANCH` / `STUDIO_REPO_ROOT_DIR` — user-defined.
 *      Lets the user override anything platform CI vars would otherwise pick, without
 *      touching `nuxt.config.ts`. Useful e.g. when committing to a content repo that
 *      isn't the deployed app's own git origin.
 *   2. Vercel / Netlify / GitHub Actions / GitLab CI / Cloudflare Workers Builds /
 *      Cloudflare Pages — fill only fields the user vars left blank.
 */
function detectFromEnv(): DetectedRepository | undefined {
	const out: DetectedRepository = {};

	if (process.env.STUDIO_REPO_URL) {
		const parsed = parseGitUrl(process.env.STUDIO_REPO_URL);
		if (parsed) Object.assign(out, parsed);
	}
	if (process.env.STUDIO_REPO_BRANCH) out.branch = process.env.STUDIO_REPO_BRANCH;
	if (process.env.STUDIO_REPO_ROOT_DIR) out.rootDir = process.env.STUDIO_REPO_ROOT_DIR;

	// Vercel
	if (
		!out.owner
		&& process.env.VERCEL_GIT_REPO_OWNER
		&& process.env.VERCEL_GIT_REPO_SLUG
		&& (process.env.VERCEL_GIT_PROVIDER === 'github' || process.env.VERCEL_GIT_PROVIDER === 'gitlab')
	) {
		out.provider = process.env.VERCEL_GIT_PROVIDER;
		out.owner = process.env.VERCEL_GIT_REPO_OWNER;
		out.repo = process.env.VERCEL_GIT_REPO_SLUG;
		if (!out.branch && process.env.VERCEL_GIT_COMMIT_REF) out.branch = process.env.VERCEL_GIT_COMMIT_REF;
	}

	// Netlify — route REPOSITORY_URL through parseGitUrl for free self-hosted support
	if (!out.owner && process.env.NETLIFY && process.env.REPOSITORY_URL) {
		const parsed = parseGitUrl(process.env.REPOSITORY_URL);
		if (parsed) Object.assign(out, parsed);
		if (!out.branch && process.env.BRANCH) out.branch = process.env.BRANCH;
	}

	// GitHub Actions
	if (!out.owner && process.env.GITHUB_ACTIONS && process.env.GITHUB_REPOSITORY?.includes('/')) {
		const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
		if (owner && repo) {
			out.provider = 'github';
			out.owner = owner;
			out.repo = repo;
		}
		if (!out.branch && process.env.GITHUB_REF_NAME) out.branch = process.env.GITHUB_REF_NAME;
	}

	// GitLab CI
	if (
		!out.owner
		&& process.env.GITLAB_CI
		&& process.env.CI_PROJECT_NAMESPACE
		&& process.env.CI_PROJECT_NAME
	) {
		out.provider = 'gitlab';
		out.owner = process.env.CI_PROJECT_NAMESPACE;
		out.repo = process.env.CI_PROJECT_NAME;
		if (!out.branch && process.env.CI_COMMIT_BRANCH) out.branch = process.env.CI_COMMIT_BRANCH;
		if (!out.instanceUrl && process.env.CI_SERVER_URL) out.instanceUrl = process.env.CI_SERVER_URL;
	}

	// Cloudflare Workers Builds / Pages — branch only (no provider/owner/repo exposed)
	if (!out.branch && process.env.WORKERS_CI_BRANCH) out.branch = process.env.WORKERS_CI_BRANCH;
	if (!out.branch && process.env.CF_PAGES_BRANCH) out.branch = process.env.CF_PAGES_BRANCH;

	return Object.keys(out).length ? out : undefined;
}

/**
 * Read repository info via the local `git` binary.
 *
 * Uses `git remote get-url origin` + `git symbolic-ref --short HEAD` rather than
 * parsing `.git/config` directly so that worktrees, submodules, and any other
 * gitdir-redirect layouts work without special-casing.
 *
 * Returns undefined when:
 *   - the directory isn't a git checkout
 *   - `git` is not on PATH (e.g., shipped tarball deploys)
 *   - HEAD is detached (no branch to report; other fields may still resolve)
 */
function detectFromGit(rootDir: string): DetectedRepository | undefined {
	const tryGit = (...args: string[]): string | undefined => {
		try {
			return execFileSync('git', args, {
				cwd: rootDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
			}).trim();
		} catch {
			return undefined;
		}
	};

	const url = tryGit('remote', 'get-url', 'origin');
	const branch = tryGit('symbolic-ref', '--short', 'HEAD');

	const out: DetectedRepository = {};
	if (url) {
		const parsed = parseGitUrl(url);
		if (parsed) Object.assign(out, parsed);
	}
	if (branch) out.branch = branch;

	return Object.keys(out).length ? out : undefined;
}

/**
 * Read repository info from the user's package.json `repository` field.
 *
 * Accepts both forms documented by npm:
 *   "repository": "github:owner/repo"        // shorthand string
 *   "repository": "owner/repo"               // defaults to github
 *   "repository": { "type": "git", "url": "https://github.com/owner/repo.git" }
 *
 * No branch info — package.json doesn't carry that.
 */
function detectFromPackageJson(rootDir: string): DetectedRepository | undefined {
	const pkgPath = resolve(rootDir, 'package.json');
	if (!existsSync(pkgPath)) return undefined;

	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
			repository?: string | { type?: string; url?: string };
		};
		const repoField = pkg.repository;
		if (!repoField) return undefined;

		const url = typeof repoField === 'string' ? repoField : repoField.url;
		if (!url) return undefined;

		const parsed = parseGitUrl(url);
		return parsed ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Orchestrate the detection cascade.
 *
 * Precedence (highest first; each source fills only fields the higher ones left blank):
 *   1. Environment variables (`STUDIO_REPO_*` first, then platform CI vars)
 *   2. Local git config (`git remote get-url origin` + `git symbolic-ref --short HEAD`)
 *   3. `package.json#repository`
 *
 * User config in `nuxt.config.ts` is applied OUTSIDE this function via the existing
 * `defu(detected, options.repository)` merge in `module.ts`, so manual values always
 * remain the topmost layer regardless of what is detected here.
 */
export function detectRepository(rootDir: string): DetectedRepository | undefined {
	const merged = defu<DetectedRepository, DetectedRepository[]>(
		detectFromEnv() ?? {},
		detectFromGit(rootDir) ?? {},
		detectFromPackageJson(rootDir) ?? {},
	);
	return Object.keys(merged).length ? merged : undefined;
}
