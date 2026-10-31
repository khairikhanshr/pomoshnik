import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { S } from '../../../common/strings'

const T = S.settings.activation
const MAX = 10

export function WakePhrases({ phrases, onChange }: { phrases: string[]; onChange(list: string[]): void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const full = phrases.length >= MAX

  const add = (): void => {
    const phrase = draft.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!phrase || full) return
    if (!phrases.includes(phrase)) onChange([...phrases, phrase])
    setDraft('')
  }

  return (
    <div className="chips">
      {phrases.map((p) => (
        <span key={p} className="chip">
          {p}
          <button
            type="button"
            className="chip-remove"
            aria-label={T.phraseRemove(p)}
            title={T.phraseRemove(p)}
            disabled={phrases.length <= 1}
            onClick={() => onChange(phrases.filter((x) => x !== p))}
          >
            <X size={12} strokeWidth={2.6} />
          </button>
        </span>
      ))}
      {!full ? (
        <span className="chip-add">
          <input
            className="chip-input"
            value={draft}
            placeholder={T.phrasePlaceholder}
            aria-label={T.phraseAdd}
            maxLength={40}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
          />
          <button type="button" className="chip-add-btn" aria-label={T.phraseAdd} title={T.phraseAdd} disabled={!draft.trim()} onClick={add}>
            <Plus size={14} />
          </button>
        </span>
      ) : (
        <span className="chips-note">{T.phrasesMax}</span>
      )}
    </div>
  )
}
