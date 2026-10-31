import { useState } from 'react'
import { Ban, Check, ChevronDown, LoaderCircle, X } from 'lucide-react'
import type { ToolCallRecord, ToolStatus } from '@shared/types'
import { formatSeconds } from '../../../common/format'
import { S } from '../../../common/strings'

const STATUS_ICON: Record<ToolStatus, React.ReactNode> = {
  running: <LoaderCircle size={14} className="spin" aria-hidden="true" />,
  ok: <Check size={14} strokeWidth={2.6} aria-hidden="true" />,
  error: <X size={14} strokeWidth={2.6} aria-hidden="true" />,
  denied: <Ban size={13} strokeWidth={2.4} aria-hidden="true" />
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

export function ToolChip({ call }: { call: ToolCallRecord }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hasArgs = Object.keys(call.args ?? {}).length > 0
  const duration = call.endedAt && call.startedAt ? formatSeconds(call.endedAt - call.startedAt) : ''

  return (
    <div className={`tool-chip tool-chip--${call.status}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="tool-chip-head"
        aria-expanded={open}
        aria-label={`${call.title}. ${S.tools.status[call.status]}${call.summary ? `. ${call.summary}` : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tool-chip-status">{STATUS_ICON[call.status]}</span>
        <span className="tool-chip-title">{call.title}</span>
        {call.summary && <span className="tool-chip-summary">{call.summary}</span>}
        <ChevronDown size={14} className="tool-chip-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="tool-chip-details">
          <div className="tool-chip-row">
            <span className="tool-chip-key">{S.tools.result}</span>
            <span>
              {S.tools.status[call.status]}
              {duration && ` · ${S.tools.duration(duration)}`}
            </span>
          </div>
          {hasArgs && (
            <div className="tool-chip-row tool-chip-row--block">
              <span className="tool-chip-key">{S.tools.args}</span>
              <pre className="tool-chip-args">
                <span className="tool-chip-name">{call.name}</span> {formatArgs(call.args)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
