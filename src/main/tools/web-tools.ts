import { shell } from 'electron'
import { clip, optEnum, reqString } from './args'
import { ok, type ToolDef } from './define'
import { ToolError } from './errors'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

export const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  yandex: 'https://yandex.ru/search/?text=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q='
} as const

export type SearchEngine = keyof typeof SEARCH_ENGINES

/** Adds https:// to bare domains and allows only http(s) / mailto links. */
export function normalizeUrl(input: string): URL {
  let text = input.trim()
  if (/^www\./i.test(text) || (/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+(:\d+)?([/?#].*)?$/u.test(text) && !/^[a-z]+:/i.test(text))) {
    text = `https://${text}`
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new ToolError(`Not a valid URL: ${input}`)
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new ToolError('Only http, https and mailto links can be opened')
  return url
}

export function searchUrl(query: string, engine: SearchEngine): string {
  return SEARCH_ENGINES[engine] + encodeURIComponent(query)
}

function hostTitle(raw: unknown): string {
  try {
    return normalizeUrl(String(raw ?? '')).hostname.replace(/^www\./, '') || 'ссылку'
  } catch {
    return 'ссылку'
  }
}

export function webTools(): ToolDef[] {
  const openUrl: ToolDef = {
    spec: {
      name: 'open_url',
      description: 'Open a web page (http/https) or a mailto: link in the default browser / mail app.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL or a bare domain such as "youtube.com".' } },
        required: ['url'],
        additionalProperties: false
      }
    },
    title: (args) => `Открываю ${hostTitle(args.url)}`,
    run: async (args) => {
      const url = normalizeUrl(reqString(args, 'url', { max: 4000 }))
      await shell.openExternal(url.href)
      const where = url.protocol === 'mailto:' ? 'the mail app' : 'the default browser'
      return ok(`Opened ${url.href} in ${where}.`, `Открыто: ${url.protocol === 'mailto:' ? url.pathname : url.hostname.replace(/^www\./, '')}`)
    }
  }

  const webSearch: ToolDef = {
    spec: {
      name: 'web_search',
      description:
        "Open a web search in the user's browser so the user can see the results. This does not return results to you; " +
        'to look something up yourself, use your own web search capability.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          engine: { type: 'string', enum: Object.keys(SEARCH_ENGINES), description: 'Search engine (default google).' }
        },
        required: ['query'],
        additionalProperties: false
      }
    },
    // Opens the browser (the model's own search shows "Ищу в интернете" instead).
    title: (args) => `Открываю поиск «${clip(String(args.query ?? ''), 40)}»`,
    run: async (args) => {
      const query = reqString(args, 'query', { max: 1000 })
      const engine = optEnum(args, 'engine', Object.keys(SEARCH_ENGINES) as SearchEngine[]) ?? 'google'
      await shell.openExternal(searchUrl(query, engine))
      return ok(`Opened ${engine} search results for "${query}" in the browser.`, `Поиск: ${clip(query, 50)}`)
    }
  }

  return [openUrl, webSearch]
}
