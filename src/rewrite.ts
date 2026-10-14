const FENCE = /^\s{0,3}(`{3,}|~{3,})/

function outsideFences(content: string, fn: (text: string) => string): string {
  const out: string[] = []
  let buffer: string[] = []
  let fence: string | undefined
  const flush = () => {
    if (buffer.length) out.push(fn(buffer.join('\n')))
    buffer = []
  }
  for (const line of content.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      out.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
    } else if (marker) {
      flush()
      out.push(line)
      fence = marker
    } else {
      buffer.push(line)
    }
  }
  flush()
  return out.join('\n')
}

export function rewriteLinks(content: string, dest: string, protectedRoots: string[]): string {
  const skip = new Set([...protectedRoots.map((r) => r.split('/')[0]), 'snippets'])
  const target = (path: string) => (skip.has(path.split(/[/#?]/)[0]!) ? `/${path}` : `/${dest}/${path}`)

  return outsideFences(content, (text) =>
    text
      .replace(/(\bfrom\s+|\bimport\s+)(["'])\/snippets\//g, `$1$2/snippets/${dest}/`)
      .replace(/(\]\(\s*<?)\/(?!\/)([^)\s>]*)/g, (_, pre, path) => `${pre}${target(path)}`)
      .replace(/^(\s{0,3}\[[^\]]+\]:\s*<?)\/(?!\/)(\S*)/gm, (_, pre, path) => `${pre}${target(path)}`)
      .replace(/(\b(?:href|src|img|logo)=\{?\s*)(["'`])\/(?!\/)([^"'`]*)\2/g, (_, pre, q, path) => `${pre}${q}${target(path)}${q}`),
  )
}
