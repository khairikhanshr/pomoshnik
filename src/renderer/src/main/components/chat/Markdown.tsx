import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ElementContent, Element } from 'hast'
import { ImageIcon } from 'lucide-react'
import { api } from '../../../common/api'
import { S } from '../../../common/strings'
import { CodeBlock } from './CodeBlock'

const SAFE_LINK = /^(https?:|mailto:)/i

function hastText(node: ElementContent): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(hastText).join('')
  return ''
}

function codeLanguage(code: Element | undefined): string | undefined {
  const cls: unknown = code?.properties?.className
  const list: string[] = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(' ') : []
  return list.find((c) => c.startsWith('language-'))?.slice('language-'.length)
}

function openLink(href: string | undefined): void {
  if (href && SAFE_LINK.test(href)) void api.app.openExternal(href)
}

const components: Components = {
  pre({ node }) {
    const code = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code')
    const text = code ? hastText(code) : node ? node.children.map(hastText).join('') : ''
    return <CodeBlock code={text.replace(/\n$/, '')} lang={codeLanguage(code)} />
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        title={href}
        onClick={(e) => {
          e.preventDefault()
          openLink(href)
        }}
      >
        {children}
      </a>
    )
  },
  // Remote images are blocked by the CSP; show them as links instead of broken images.
  img({ src, alt }) {
    const href = typeof src === 'string' ? src : undefined
    return (
      <a
        className="md-img-link"
        href={href}
        onClick={(e) => {
          e.preventDefault()
          openLink(href)
        }}
      >
        <ImageIcon size={14} aria-hidden="true" />
        {alt || S.messages.imageLink}
      </a>
    )
  },
  table({ children }) {
    return (
      <div className="md-table-wrap">
        <table>{children}</table>
      </div>
    )
  },
  input({ checked, type }) {
    if (type !== 'checkbox') return null
    return <span className={`md-check${checked ? ' is-checked' : ''}`} aria-label={checked ? '✓' : '○'} />
  }
}

const remarkPlugins = [remarkGfm]

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }): React.JSX.Element {
  return (
    <div className={`md${streaming ? ' md--streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
