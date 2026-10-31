export interface InstalledApp {
  /** Display name (localized when known). */
  name: string
  /** Every name to match against: display name, file name, Start menu name. */
  names: string[]
  /** macOS: .app path; Windows: AppUserModelID or shortcut path. */
  id: string
  kind: 'bundle' | 'appx' | 'shortcut'
}

export interface RunningApp {
  name: string
  names: string[]
  pid: number
  /** macOS bundle path / Windows executable path. */
  path?: string
  bundleId?: string
  /** Windows main window title. */
  title?: string
  active?: boolean
}

export interface CloseOutcome {
  /** Apps that are gone after the request. */
  closed: string[]
  /** Apps still running (unsaved-changes prompt, minimized to tray, …). */
  stillRunning: string[]
}

export interface AppBackend {
  installed(force?: boolean): Promise<InstalledApp[]>
  running(signal?: AbortSignal): Promise<RunningApp[]>
  launch(app: InstalledApp): Promise<void>
  /** Last resort for names not in the catalog (open -a / Start-Process). Resolves false when nothing started. */
  launchByName(name: string, signal?: AbortSignal): Promise<boolean>
  /** Windows built-ins: an executable name or a URI such as ms-settings:. */
  launchFallback(target: string, signal?: AbortSignal): Promise<void>
  close(apps: RunningApp[], force: boolean, signal?: AbortSignal): Promise<CloseOutcome>
  focus(app: RunningApp, signal?: AbortSignal): Promise<boolean>
  /** Opens the default web browser; resolves with its name. */
  openDefaultBrowser(signal?: AbortSignal): Promise<string>
}
