; Jarvis - custom NSIS hooks, included by electron-builder (electron-builder.yml: nsis.include).

!macro customUnInstall
  ; Real uninstall only (not the silent uninstall that runs during an update):
  ; remove the "launch at login" entry written by app.setLoginItemSettings().
  ; Electron names the value after the AppUserModelID: the appId when the app calls
  ; app.setAppUserModelId('com.pomoshnik.jarvis'), otherwise the default "electron.app.Jarvis".
  ; User data (%APPDATA%\Jarvis - chats, settings, encrypted keys) is intentionally kept.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.pomoshnik.jarvis"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Jarvis"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.pomoshnik.jarvis"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.Jarvis"
  ${endIf}
!macroend
