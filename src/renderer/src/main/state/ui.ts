import { create } from 'zustand'
import { isSettingsTabId, SETTINGS_TAB_IDS, type ImageRef, type MainView, type SettingsTabId } from '@shared/types'

/** Tab ids are shared with main (NavigateRequest.settingsTab). */
export type SettingsTab = SettingsTabId
export const SETTINGS_TABS: readonly SettingsTab[] = SETTINGS_TAB_IDS
export const isSettingsTab = isSettingsTabId

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: number
  text: string
  kind: ToastKind
}

export interface ConfirmRequest {
  title: string
  message: string
  confirmText: string
  danger?: boolean
  resolve(ok: boolean): void
}

export interface MenuItem {
  label: string
  icon?: React.ReactNode
  danger?: boolean
  onSelect(): void
}

export interface ContextMenuState {
  x: number
  y: number
  items: MenuItem[]
}

interface UiState {
  view: MainView
  settingsTab: SettingsTab
  lightbox: { images: ImageRef[]; index: number } | null
  toasts: Toast[]
  confirm: ConfirmRequest | null
  menu: ContextMenuState | null
  /** Incremented to ask the composer to take focus. */
  composerFocus: number

  openSettings(tab?: SettingsTab): void
  openChatView(): void
  setSettingsTab(tab: SettingsTab): void
  openLightbox(images: ImageRef[], index: number): void
  closeLightbox(): void
  pushToast(text: string, kind?: ToastKind): void
  dismissToast(id: number): void
  askConfirm(req: Omit<ConfirmRequest, 'resolve'>): Promise<boolean>
  settleConfirm(ok: boolean): void
  openMenu(menu: ContextMenuState): void
  closeMenu(): void
  focusComposer(): void
}

let toastSeq = 0
const TOAST_MS = 3200

export const useUi = create<UiState>((set, get) => ({
  view: 'chat',
  settingsTab: 'ai',
  lightbox: null,
  toasts: [],
  confirm: null,
  menu: null,
  composerFocus: 0,

  openSettings(tab) {
    set({ view: 'settings', settingsTab: tab ?? get().settingsTab, menu: null })
  },
  openChatView() {
    set({ view: 'chat', menu: null })
  },
  setSettingsTab(tab) {
    set({ settingsTab: tab })
  },
  openLightbox(images, index) {
    if (images.length) set({ lightbox: { images, index: Math.max(0, Math.min(index, images.length - 1)) } })
  },
  closeLightbox() {
    set({ lightbox: null })
  },
  pushToast(text, kind = 'info') {
    const id = ++toastSeq
    set({ toasts: [...get().toasts.filter((t) => t.text !== text), { id, text, kind }].slice(-4) })
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? TOAST_MS * 1.8 : TOAST_MS)
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },
  askConfirm(req) {
    get().confirm?.resolve(false)
    return new Promise<boolean>((resolve) => set({ confirm: { ...req, resolve } }))
  },
  settleConfirm(ok) {
    const req = get().confirm
    set({ confirm: null })
    req?.resolve(ok)
  },
  openMenu(menu) {
    set({ menu })
  },
  closeMenu() {
    set({ menu: null })
  },
  focusComposer() {
    set({ composerFocus: get().composerFocus + 1 })
  }
}))

export function toast(text: string, kind: ToastKind = 'info'): void {
  useUi.getState().pushToast(text, kind)
}
