import { eventHandler, readBody, createError } from 'h3'
import { useRuntimeConfig } from '#imports'
import { requireStudioAuth } from '../../utils/auth'
import * as openpgp from 'openpgp'

/**
 * The canonical git commit object body that GitHub re-derives server-side to
 * verify signatures submitted via the Git Data API `POST /git/commits` endpoint.
 *
 * Format (no trailing newline on the last field, matching git's internal format):
 *
 *   tree <tree-sha>\n
 *   parent <parent-sha>\n
 *   author <name> <email> <unix-ts> +0000\n
 *   committer <name> <email> <unix-ts> +0000\n
 *   \n
 *   <message>
 */
export interface SignCommitBody {
  /** New tree SHA (from POST /git/trees) */
  tree: string
  /** Parent commit SHA */
  parent: string
  /** Author and committer name */
  name: string
  /** Author and committer email */
  email: string
  /** ISO 8601 date string — converted to unix timestamp for the commit object */
  date: string
  /** Commit message (including any co-author trailers already appended) */
  message: string
}

/**
 * Build the canonical git commit object body text exactly as git does.
 * This is the byte sequence that will be hashed (SHA-1) by git and is also
 * what GitHub verifies the PGP signature against.
 */
function buildCommitObject(body: SignCommitBody): string {
  const dateMs = new Date(body.date).getTime()
  if (Number.isNaN(dateMs)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid date format provided. Use an ISO 8601 date string.',
    })
  }

  const unixTs = Math.floor(dateMs / 1000)
  const tzOffset = '+0000'
  const authorLine = `author ${body.name} <${body.email}> ${unixTs} ${tzOffset}`
  const committerLine = `committer ${body.name} <${body.email}> ${unixTs} ${tzOffset}`

  return [
    `tree ${body.tree}`,
    `parent ${body.parent}`,
    authorLine,
    committerLine,
    '',
    body.message,
  ].join('\n')
}

export default eventHandler(async (event) => {
  await requireStudioAuth(event)

  const config = useRuntimeConfig(event)
  const signingConfig = config.studio?.git?.signing

  if (!signingConfig?.enabled) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Commit signing is not enabled. Set studio.git.signing.enabled in your nuxt.config.',
    })
  }

  const privateKeyArmored = signingConfig.privateKey
  if (!privateKeyArmored) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Commit signing key is not configured. Set STUDIO_SIGNING_PRIVATE_KEY environment variable.',
    })
  }

  const body = await readBody<SignCommitBody>(event)

  if (!body.tree || !body.parent || !body.name || !body.email || !body.date || body.message === undefined) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing required fields: tree, parent, name, email, date, message',
    })
  }

  const commitObject = buildCommitObject(body)

  let privateKey: Awaited<ReturnType<typeof openpgp.readPrivateKey>>
  try {
    privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored })
  }
  catch {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to parse PGP private key. Ensure STUDIO_SIGNING_PRIVATE_KEY is a valid ASCII-armored key.',
    })
  }

  if (signingConfig.passphrase) {
    try {
      privateKey = await openpgp.decryptKey({
        privateKey,
        passphrase: signingConfig.passphrase,
      })
    }
    catch {
      throw createError({
        statusCode: 500,
        statusMessage: 'Failed to decrypt PGP private key. Check STUDIO_SIGNING_KEY_PASSPHRASE.',
      })
    }
  }

  let signature: string
  try {
    const message = await openpgp.createMessage({ text: commitObject })
    signature = await openpgp.sign({
      message,
      signingKeys: privateKey,
      detached: true,
      format: 'armored',
    })
  }
  catch {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to sign commit object. The PGP key may be invalid or incompatible.',
    })
  }

  return { signature }
})
