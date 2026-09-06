import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetMediaUrl = vi.fn()
const mockDownloadMedia = vi.fn()
vi.mock('./meta-api', () => ({
  getMediaUrl: (...args: unknown[]) => mockGetMediaUrl(...args),
  downloadMedia: (...args: unknown[]) => mockDownloadMedia(...args),
}))

import { transcribeInboundAudio } from './transcribe-audio'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status })
}

const ARGS = { mediaId: 'wamid.MEDIA1', accessToken: 'meta-token' }

describe('transcribeInboundAudio', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.MUNSIT_API_KEY = 'munsit-key'
    delete process.env.MUNSIT_HOTWORDS
    delete process.env.MUNSIT_TIMEOUT_MS

    mockGetMediaUrl.mockReset().mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/voice',
      mimeType: 'audio/ogg',
      fileSize: 4096,
    })
    mockDownloadMedia.mockReset().mockResolvedValue({
      buffer: Buffer.from('fake-ogg-bytes'),
      contentType: 'audio/ogg',
    })

    fetchMock = vi.fn().mockResolvedValue(
      okResponse({ data: { transcription: 'أحتاج إلى فاتورة' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    errorSpy.mockRestore()
    process.env = { ...originalEnv }
  })

  it('returns the trimmed transcript on success', async () => {
    const result = await transcribeInboundAudio(ARGS)
    expect(result).toBe('أحتاج إلى فاتورة')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('posts multipart form data with the x-api-key header and model field', async () => {
    await transcribeInboundAudio(ARGS)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.munsit.com/api/v1/audio/transcribe')
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe('munsit-key')
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get('model')).toBe('munsit')
    expect(form.get('file')).toBeInstanceOf(Blob)
    // No MUNSIT_HOTWORDS set → field omitted entirely.
    expect(form.has('hotwords')).toBe(false)
  })

  it('includes hotwords verbatim when configured', async () => {
    process.env.MUNSIT_HOTWORDS = 'شفاء الطفل الداخلي,قراءة الهالة الطاقية'
    await transcribeInboundAudio(ARGS)

    const form = fetchMock.mock.calls[0][1].body as FormData
    expect(form.get('hotwords')).toBe('شفاء الطفل الداخلي,قراءة الهالة الطاقية')
  })

  it('returns null and logs a greppable error when MUNSIT_API_KEY is unset', async () => {
    delete process.env.MUNSIT_API_KEY
    const result = await transcribeInboundAudio(ARGS)

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[munsit-transcribe] failed:'),
    )
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('MUNSIT_API_KEY is not configured'),
    )
  })

  it('returns null and logs the status when Munsit responds non-2xx', async () => {
    fetchMock.mockResolvedValue(errorResponse(429, 'rate limited'))
    const result = await transcribeInboundAudio(ARGS)

    expect(result).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[munsit-transcribe] failed: Munsit returned 429'),
    )
  })

  it('returns null and logs when the response body is malformed', async () => {
    fetchMock.mockResolvedValue(okResponse({ data: { oops: true } }))
    const result = await transcribeInboundAudio(ARGS)

    expect(result).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[munsit-transcribe] failed: malformed response body'),
    )
  })

  it('returns null and logs when fetching the media from Meta fails', async () => {
    mockGetMediaUrl.mockRejectedValue(new Error('media id expired'))
    const result = await transcribeInboundAudio(ARGS)

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[munsit-transcribe] failed: could not fetch the audio from Meta — media id expired',
      ),
    )
  })

  it('returns null and logs a distinct reason on timeout', async () => {
    fetchMock.mockImplementation(() => {
      const err = new Error('The operation was aborted')
      err.name = 'TimeoutError'
      return Promise.reject(err)
    })
    const result = await transcribeInboundAudio(ARGS)

    expect(result).toBeNull()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[munsit-transcribe] failed: timed out'),
    )
  })
})
