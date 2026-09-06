import { describe, it, expect } from 'vitest'
import { buildHandoffFields } from './handoff'

describe('buildHandoffFields', () => {
  it('returns the reply count and the last customer message', () => {
    const fields = buildHandoffFields({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'I want a refund' },
      ],
      replyCount: 2,
    })
    expect(fields).toEqual({ replyCount: 2, lastMessage: 'I want a refund' })
  })

  it('picks the most recent customer turn, ignoring assistant turns', () => {
    const fields = buildHandoffFields({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a reply' },
      ],
      replyCount: 1,
    })
    expect(fields.lastMessage).toBe('second')
  })

  it('collapses whitespace and truncates a long message', () => {
    const long = 'x'.repeat(300)
    const fields = buildHandoffFields({
      messages: [{ role: 'user', content: long }],
      replyCount: 0,
    })
    expect(fields.lastMessage).toContain('…')
    // 160-char cap on the quote.
    expect(fields.lastMessage!.length).toBeLessThanOrEqual(160)
  })

  it('degrades gracefully when there is no customer message', () => {
    const fields = buildHandoffFields({
      messages: [{ role: 'assistant', content: 'greeting' }],
      replyCount: 0,
    })
    expect(fields).toEqual({ replyCount: 0, lastMessage: null })
  })
})
