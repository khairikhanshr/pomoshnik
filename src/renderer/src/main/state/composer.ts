import { create } from 'zustand'
import type { ImageRef } from '@shared/types'
import { api, errorMessage } from '../../common/api'
import { S } from '../../common/strings'
import { toImportable } from '../image-convert'
import { toast } from './ui'

const MAX_ATTACHMENTS = 8

interface ComposerState {
  attachments: ImageRef[]
  /** Uploads / captures in flight. */
  pending: number
  capturing: boolean
  add(image: ImageRef): void
  remove(id: string): void
  clear(): void
  importFiles(files: File[]): Promise<void>
  pick(): Promise<void>
  capture(): Promise<void>
}

export const useComposer = create<ComposerState>((set, get) => {
  const track = async (fn: () => Promise<void>): Promise<void> => {
    set({ pending: get().pending + 1 })
    try {
      await fn()
    } finally {
      set({ pending: Math.max(0, get().pending - 1) })
    }
  }

  return {
    attachments: [],
    pending: 0,
    capturing: false,

    add(image) {
      const list = get().attachments.filter((a) => a.id !== image.id)
      set({ attachments: [...list, image].slice(-MAX_ATTACHMENTS) })
    },

    remove(id) {
      set({ attachments: get().attachments.filter((a) => a.id !== id) })
    },

    clear() {
      set({ attachments: [] })
    },

    async importFiles(files) {
      const images = files.filter((f) => f.type.startsWith('image/'))
      if (images.length < files.length) toast(S.composer.onlyImages, 'info')
      for (const file of images) {
        await track(async () => {
          try {
            const { data, mime } = await toImportable(file)
            const ref = await api.media.importImage(data, mime)
            get().add(ref)
          } catch (err) {
            toast(errorMessage(err) || S.composer.attachFailed, 'error')
          }
        })
      }
    },

    async pick() {
      await track(async () => {
        try {
          const ref = await api.media.pickImage()
          if (ref) get().add(ref)
        } catch (err) {
          toast(errorMessage(err) || S.composer.attachFailed, 'error')
        }
      })
    },

    async capture() {
      if (get().capturing) return
      set({ capturing: true })
      await track(async () => {
        try {
          get().add(await api.media.captureScreen())
        } catch (err) {
          toast(errorMessage(err) || S.composer.captureFailed, 'error')
        } finally {
          set({ capturing: false })
        }
      })
    }
  }
})
