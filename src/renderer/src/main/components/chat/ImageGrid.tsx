import { MonitorUp } from 'lucide-react'
import type { ImageRef } from '@shared/types'
import { S } from '../../../common/strings'
import { useUi } from '../../state/ui'

export function ImageGrid({ images, align = 'start' }: { images: ImageRef[]; align?: 'start' | 'end' }): React.JSX.Element {
  const openLightbox = useUi((s) => s.openLightbox)
  return (
    <div className={`img-grid img-grid--${images.length === 1 ? 'single' : 'multi'} img-grid--${align}`}>
      {images.map((img, i) => {
        const label = img.kind === 'screenshot' ? S.images.screenshot : S.images.upload
        const ratio = img.width && img.height ? `${img.width} / ${img.height}` : undefined
        return (
          <button
            key={img.id}
            type="button"
            className="img-thumb"
            aria-label={`${S.images.open}: ${label}`}
            onClick={() => openLightbox(images, i)}
            style={images.length === 1 && ratio ? { aspectRatio: ratio } : undefined}
          >
            <img src={img.url} alt={label} loading="lazy" draggable={false} />
            {img.kind === 'screenshot' && (
              <span className="img-badge">
                <MonitorUp size={11} aria-hidden="true" />
                {S.images.screenshot}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
