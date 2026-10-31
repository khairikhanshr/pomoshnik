// Pure placement of the overlay HUD inside a display's work area.
import type { OverlayPosition } from '@shared/types'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const OVERLAY_SIZE = { width: 380, height: 320 } as const
export const OVERLAY_MARGIN = 16

export function overlayBounds(
  workArea: Rect,
  position: OverlayPosition,
  size: { width: number; height: number } = OVERLAY_SIZE,
  margin = OVERLAY_MARGIN
): Rect {
  const width = Math.min(size.width, Math.max(1, workArea.width - 2 * margin))
  const height = Math.min(size.height, Math.max(1, workArea.height - 2 * margin))
  const left = workArea.x + margin
  const right = workArea.x + workArea.width - width - margin
  const center = workArea.x + Math.round((workArea.width - width) / 2)
  const top = workArea.y + margin
  const bottom = workArea.y + workArea.height - height - margin
  switch (position) {
    case 'top-center':
      return { x: center, y: top, width, height }
    case 'bottom-center':
      return { x: center, y: bottom, width, height }
    case 'bottom-right':
      return { x: Math.max(left, right), y: bottom, width, height }
    case 'top-right':
    default:
      return { x: Math.max(left, right), y: top, width, height }
  }
}
