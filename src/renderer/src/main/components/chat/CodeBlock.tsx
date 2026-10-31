import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { S } from '../../../common/strings'
import { copyText } from '../../clipboard'

export function CodeBlock({ code, lang }: { code: string; lang?: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = async (): Promise<void> => {
    if (!(await copyText(code, false))) return
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || S.messages.code}</span>
        <button type="button" className={`code-copy${copied ? ' is-done' : ''}`} onClick={() => void copy()} aria-label={S.messages.copyCode}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span>{copied ? S.common.copied : S.common.copy}</span>
        </button>
      </div>
      <pre className="code-pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}
