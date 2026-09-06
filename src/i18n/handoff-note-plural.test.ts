import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';

// `Inbox.aiBanner.handoffNote` replaced buildHandoffSummary's hand-rolled
// English singular/plural wording (removed along with the two tests that
// covered it in src/lib/ai/handoff.test.ts — see migration 049). That
// wording now lives entirely in the message catalogue, so it needs its
// own coverage here: a hand-written `{count, plural, one{…} other{…}}`
// would render wrong for 2, 3–10, and 11+ in Arabic, which has six CLDR
// plural categories, not two.

const MESSAGES_DIR = join(process.cwd(), 'messages');

function loadCatalogue(locale: string) {
  return JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8'));
}

describe('Inbox.aiBanner.handoffNote — plural correctness', () => {
  it('covers every Arabic CLDR plural category with no parser errors', () => {
    const messages = loadCatalogue('ar');
    const errors: string[] = [];
    const t = createTranslator({
      locale: 'ar',
      messages,
      onError: (err) => errors.push(err.code),
    });

    // One representative count per CLDR category real Intl.PluralRules('ar')
    // resolves to zero/one/two/few/many/other, plus the boundaries
    // auto_reply_max_per_conversation actually allows (1–20).
    const expectCategory: Record<number, RegExp> = {
      0: /دون الرد/,
      1: /ردّ واحد/,
      2: /ردّين/,
      3: /3 ردود/,
      10: /10 ردود/,
      11: /11 ردًا/,
      20: /20 ردًا/,
      100: /100 رد\./,
    };

    for (const [count, expected] of Object.entries(expectCategory)) {
      const rendered = t('Inbox.aiBanner.handoffNote', { count: Number(count) });
      expect(rendered, `count=${count}`).toMatch(expected);
    }
    expect(errors).toEqual([]);
  });

  it('renders singular/plural correctly in English', () => {
    const messages = loadCatalogue('en');
    const t = createTranslator({ locale: 'en', messages });

    expect(t('Inbox.aiBanner.handoffNote', { count: 0 })).toContain('without replying');
    expect(t('Inbox.aiBanner.handoffNote', { count: 1 })).toContain('after 1 reply.');
    expect(t('Inbox.aiBanner.handoffNote', { count: 2 })).toContain('after 2 replies.');
  });

  it('interpolates the quoted last message in every locale', () => {
    for (const locale of ['en', 'ar', 'ko']) {
      const t = createTranslator({ locale, messages: loadCatalogue(locale) });
      expect(t('Inbox.aiBanner.handoffLastMessage', { message: 'refund please' })).toContain(
        'refund please',
      );
    }
  });
});
