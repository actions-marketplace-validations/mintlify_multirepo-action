import { describe, expect, it } from 'vitest'
import { rewriteLinks } from '../src/rewrite.js'

describe('rewriteLinks', () => {
  it('prefixes root-relative links, images, attributes, and snippet imports', () => {
    const input = [
      "import Note from '/snippets/note.mdx'",
      '',
      'See [guide](/guides/start#top) and ![logo](/images/logo.png).',
      '<Card href="/guides/start" />',
      '<img src="/images/a.png" />',
      '[ref]: /reference/x',
    ].join('\n')
    expect(rewriteLinks(input, 'api', ['api', 'sdks'])).toBe(
      [
        "import Note from '/snippets/api/note.mdx'",
        '',
        'See [guide](/api/guides/start#top) and ![logo](/api/images/logo.png).',
        '<Card href="/api/guides/start" />',
        '<img src="/api/images/a.png" />',
        '[ref]: /api/reference/x',
      ].join('\n'),
    )
  })

  it('leaves external, protocol-relative, relative, and cross-source links alone', () => {
    const input = '[a](https://x.com) [b](//cdn.x.com/a.png) [c](./local) [d](/sdks/js) [e](#anchor)'
    expect(rewriteLinks(input, 'api', ['api', 'sdks'])).toBe(input)
  })

  it('skips fenced code blocks', () => {
    const input = ['[a](/x)', '```mdx', '[b](/y)', '```', '[c](/z)'].join('\n')
    expect(rewriteLinks(input, 'api', ['api'])).toBe(['[a](/api/x)', '```mdx', '[b](/y)', '```', '[c](/api/z)'].join('\n'))
  })
})
