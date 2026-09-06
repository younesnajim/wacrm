import { getMediaUrl, downloadMedia } from './meta-api'
import { extensionForMime } from '@/lib/media/filename'

/**
 * Transcribes an inbound WhatsApp voice note via Munsit so its content
 * reaches the AI agent, the inbox, and outbound webhooks like a normal
 * text message (the transcript is written to `messages.content_text`
 * by the caller; `content_type` stays 'audio' and `media_url` /
 * `media_type` are untouched).
 *
 * Munsit is a separate, fixed transcription service — NOT gated on the
 * account's `ai_configs.provider` (which may be 'anthropic', with no
 * transcription endpoint at all). Configured per DEPLOYMENT via env
 * vars, not per account in `ai_configs`: this codebase runs one
 * instance per client, and the Munsit key/hotwords are the operator's
 * own subscription for that instance — not a credential an end
 * customer brings themselves the way an `ai_configs` BYO chat key is.
 * See MUNSIT_API_KEY / MUNSIT_HOTWORDS in .env.local.example.
 */

const MUNSIT_ENDPOINT = 'https://api.munsit.com/api/v1/audio/transcribe'

/** Generous enough for a real transcription call (upload + STT), while
 *  still leaving headroom under the webhook route's 60s `after()`
 *  ceiling for everything else that runs on the same inbound message
 *  (mirroring, automations, flows, the AI reply's own LLM call). */
const DEFAULT_TIMEOUT_MS = 20_000

export interface TranscribeInboundAudioArgs {
  /** Meta's media id for the voice note. */
  mediaId: string
  /** The account's WhatsApp access token — needed for the same
   *  media-id → URL → bytes two-step used elsewhere (meta-api.ts). */
  accessToken: string
}

/**
 * Logs every failure with the same greppable prefix and a short, stable
 * reason string, so an operator can alert on "[munsit-transcribe] failed"
 * without needing to touch this file again to add a new case.
 */
function logFailure(reason: string, detail?: unknown): void {
  const suffix =
    detail === undefined
      ? ''
      : ` — ${detail instanceof Error ? detail.message : String(detail)}`
  console.error(`[munsit-transcribe] failed: ${reason}${suffix}`)
}

/**
 * Best-effort — same contract as `mirrorInboundMedia`: NEVER throws.
 * Returns the transcript, or `null` on any failure (unconfigured,
 * network error, timeout, non-2xx, malformed response). The caller
 * falls back to `content_text: null` — exactly today's behavior for a
 * voice note, so a Munsit outage degrades gracefully rather than
 * breaking message ingestion.
 */
export async function transcribeInboundAudio(
  args: TranscribeInboundAudioArgs,
): Promise<string | null> {
  const { mediaId, accessToken } = args

  const apiKey = process.env.MUNSIT_API_KEY
  if (!apiKey) {
    logFailure('MUNSIT_API_KEY is not configured')
    return null
  }

  let buffer: Buffer
  let mimeType: string
  try {
    const info = await getMediaUrl({ mediaId, accessToken })
    const downloaded = await downloadMedia({
      downloadUrl: info.url,
      accessToken,
    })
    buffer = downloaded.buffer
    mimeType = info.mimeType || downloaded.contentType
  } catch (error) {
    logFailure('could not fetch the audio from Meta', error)
    return null
  }

  try {
    const form = new FormData()
    form.append(
      'file',
      // Buffer's `.buffer` is typed ArrayBufferLike (it could in theory
      // be a SharedArrayBuffer), which Blob's BlobPart doesn't accept.
      // Re-wrapping in a fresh Uint8Array copies into a plain
      // ArrayBuffer and satisfies the type.
      new Blob([new Uint8Array(buffer)], { type: mimeType }),
      `${mediaId}.${extensionForMime(mimeType)}`,
    )
    form.append('model', 'munsit')
    const hotwords = process.env.MUNSIT_HOTWORDS?.trim()
    if (hotwords) form.append('hotwords', hotwords)

    const timeoutMs = Number(process.env.MUNSIT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
    const response = await fetch(MUNSIT_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logFailure(`Munsit returned ${response.status}`, body || undefined)
      return null
    }

    const json = await response.json().catch(() => null)
    const transcription = json?.data?.transcription
    if (typeof transcription !== 'string' || !transcription.trim()) {
      logFailure('malformed response body', JSON.stringify(json))
      return null
    }

    return transcription.trim()
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    logFailure(timedOut ? 'timed out' : 'request error', error)
    return null
  }
}
