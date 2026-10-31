import { useEffect, useState } from 'react'
import type { NavigateRequest } from '@shared/types'
import { api, errorMessage } from '../common/api'
import { Orb } from '../common/Orb'
import { S } from '../common/strings'
import { useAssistant } from './state/assistant'
import { useChats } from './state/chats'
import { useSettings } from './state/settings'
import { isSettingsTab, useUi } from './state/ui'
import { Sidebar } from './components/sidebar/Sidebar'
import { ChatView } from './components/chat/ChatView'
import { SettingsView } from './components/settings/SettingsView'
import { Lightbox } from './components/ui/Lightbox'
import { Toasts } from './components/ui/Toasts'
import { ConfirmDialog } from './components/ui/ConfirmDialog'
import { ContextMenu } from './components/ui/ContextMenu'

function navigate(nav: NavigateRequest): void {
  const ui = useUi.getState()
  if (nav.view === 'settings' || (!nav.view && nav.settingsTab)) {
    ui.openSettings(isSettingsTab(nav.settingsTab) ? nav.settingsTab : undefined)
    return
  }
  if (nav.chatId) void useChats.getState().openChat(nav.chatId)
  else ui.openChatView()
}

function useBootstrap(): { ready: boolean; error: string | null } {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Subscribe before loading so no event slips between the snapshot and the subscription.
    const offs = [
      api.chats.onEvent((ev) => useChats.getState().applyEvent(ev)),
      api.settings.onChanged((s) => useSettings.getState().apply(s)),
      api.assistant.onState((s) => useAssistant.getState().apply(s)),
      api.app.onNavigate(navigate)
    ]
    Promise.all([useSettings.getState().load(), useChats.getState().refreshList(), useAssistant.getState().load()])
      .then(() => setReady(true))
      .catch((err: unknown) => setError(errorMessage(err) || S.common.unknownError))
    return () => offs.forEach((off) => off())
  }, [])

  return { ready, error }
}

function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = api.platform === 'darwin' ? e.metaKey : e.ctrlKey
      const ui = useUi.getState()
      if (ui.confirm || ui.lightbox) return
      if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyN') {
        e.preventDefault()
        useChats.getState().newChat()
      } else if (mod && e.key === ',') {
        e.preventDefault()
        ui.openSettings()
      } else if (mod && (e.code === 'KeyK' || (e.code === 'KeyF' && ui.view === 'chat'))) {
        e.preventDefault()
        ui.openChatView()
        window.setTimeout(() => document.getElementById('chat-search')?.focus(), 0)
      } else if (e.key === 'Escape' && ui.view === 'settings' && !ui.menu && !e.defaultPrevented) {
        const target = e.target as HTMLElement | null
        if (target?.closest('[data-hotkey-recording]')) return
        ui.openChatView()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Dropping a file outside the chat drop zone must not navigate the window to it. */
function usePreventFileNavigation(): void {
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])
}

export function App(): React.JSX.Element {
  const { ready, error } = useBootstrap()
  const view = useUi((s) => s.view)
  useGlobalShortcuts()
  usePreventFileNavigation()

  if (!ready) {
    return (
      <div className="splash">
        <Orb size={120} phase={error ? 'error' : 'thinking'} />
        <p className={`splash-text${error ? ' splash-text--error' : ''}`} role={error ? 'alert' : 'status'}>
          {error ?? S.app.loading}
        </p>
      </div>
    )
  }

  return (
    <div className="app" data-view={view}>
      <div className="workspace" hidden={view !== 'chat'}>
        <Sidebar />
        <ChatView />
      </div>
      {view === 'settings' && <SettingsView />}
      <Lightbox />
      <ContextMenu />
      <ConfirmDialog />
      <Toasts />
    </div>
  )
}
