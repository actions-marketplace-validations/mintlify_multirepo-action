import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'

describe('parseConfig', () => {
  it('applies defaults and normalizes paths', () => {
    const config = parseConfig({ sources: [{ repo: 'acme/api', destination: '/api/', path: './docs/' }] })
    expect(config).toEqual({
      base: 'docs.base.json',
      output: 'docs.json',
      sources: [{ repo: 'acme/api', ref: undefined, path: 'docs', destination: 'api', name: undefined, rewriteLinks: true, exclude: [] }],
    })
  })

  it.each([
    [{ sources: [] }, /non-empty/],
    [{ sources: [{ repo: 'nope', destination: 'a' }] }, /owner\/repo/],
    [{ sources: [{ repo: 'a/b', destination: '.' }] }, /subdirectory/],
    [{ sources: [{ repo: 'a/b', destination: '../x' }] }, /subdirectory/],
    [{ sources: [{ repo: 'a/b', destination: 'snippets' }] }, /cannot start/],
    [{ sources: [{ repo: 'a/b', destination: 'x', path: '../..' }] }, /inside/],
    [{ sources: [{ repo: 'a/b', destination: 'api' }, { repo: 'a/c', destination: 'api/v2' }] }, /overlap/],
    [{ base: 'docs.json', sources: [{ repo: 'a/b', destination: 'x' }] }, /different/],
  ])('rejects %j', (raw, error) => {
    expect(() => parseConfig(raw)).toThrow(error)
  })
})
