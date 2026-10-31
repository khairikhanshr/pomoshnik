import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { S } from '../../../common/strings'
import { useUi } from '../../state/ui'
import { Modal } from './Modal'

export function Lightbox(): React.JSX.Element | null {
  const lightbox = useUi((s) => s.lightbox)
  const close = useUi((s) => s.closeLightbox)
  const open = useUi((s) => s.openLightbox)
  if (!lightbox) return null

  const { images, index } = lightbox
  const image = images[index]
  const many = images.length > 1
  const go = (delta: number): void => open(images, (index + delta + images.length) % images.length)
  const caption = [
    image.kind === 'screenshot' ? S.images.screenshot : S.images.upload,
    image.width && image.height ? `${image.width} × ${image.height}` : '',
    many ? S.images.counter(index + 1, images.length) : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Modal
      label={S.images.lightbox}
      onClose={close}
      className="lightbox"
      initialFocus=".lightbox-close"
      onKeyDown={(e) => {
        if (!many) return
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          go(1)
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          go(-1)
        }
      }}
    >
      <div className="lightbox-stage" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <img key={image.id} className="lightbox-img" src={image.url} alt={caption} draggable={false} />
      </div>
      <div className="lightbox-bar">
        <span className="lightbox-caption">{caption}</span>
        <div className="lightbox-actions">
          {many && (
            <>
              <button type="button" className="icon-btn icon-btn--md" aria-label={S.images.prev} onClick={() => go(-1)}>
                <ChevronLeft size={18} />
              </button>
              <button type="button" className="icon-btn icon-btn--md" aria-label={S.images.next} onClick={() => go(1)}>
                <ChevronRight size={18} />
              </button>
            </>
          )}
          <button type="button" className="icon-btn icon-btn--md lightbox-close" aria-label={S.common.close} onClick={close}>
            <X size={18} />
          </button>
        </div>
      </div>
    </Modal>
  )
}
