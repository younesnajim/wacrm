import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { reindexAccountDocuments } from '@/lib/ai/knowledge'

/**
 * POST /api/ai/knowledge/reindex  (admin+)
 *
 * Re-chunk and re-embed every document in the account. The main use is
 * after adding an embeddings key: existing documents were stored
 * lexical-only, and this backfills their vectors so semantic search
 * turns on. Also recovers documents whose indexing failed earlier.
 *
 * (The same backfill now also fires automatically from `POST
 * /api/ai/config` when an embeddings key is newly set or changed — this
 * endpoint remains as the manual/recovery path, e.g. after a mid-run
 * failure or for accounts that added their key before that existed.)
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-reindex:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      supabase,
      accountId,
    )
    // The whole point of Reindex is usually to backfill embeddings — so
    // if a key is configured but can't be decrypted, don't quietly do a
    // lexical-only pass and report success. Stop and tell the admin.
    if (corrupt) {
      return NextResponse.json(
        {
          success: false,
          reindexed: 0,
          error:
            'Your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key in Settings → AI Assistant). Nothing was reindexed.',
        },
        { status: 200 },
      )
    }

    let result
    try {
      result = await reindexAccountDocuments(supabase, accountId, embeddingsApiKey)
    } catch (err) {
      console.error('[ai/knowledge/reindex] fetch error:', err)
      return NextResponse.json(
        { error: 'Failed to load documents' },
        { status: 500 },
      )
    }

    if (result.error) {
      // One bad document (e.g. a mid-run embeddings rate-limit) should
      // not be reported as a hard failure — just stop and say how far it got.
      console.error(`[ai/knowledge/reindex] stopped after ${result.reindexed}/${result.total}:`, result.error)
      return NextResponse.json(
        {
          success: false,
          reindexed: result.reindexed,
          total: result.total,
          error: `Reindexed ${result.reindexed}, then hit an error: ${result.error}`,
        },
        { status: 200 },
      )
    }

    return NextResponse.json({ success: true, reindexed: result.reindexed })
  } catch (err) {
    return toErrorResponse(err)
  }
}
