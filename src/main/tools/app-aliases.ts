// Spoken / localized app names -> names to look for on each platform.
import { normalizeName } from './fuzzy'

export interface AppAlias {
  /** Spoken forms (Russian, English, slang); compared after normalizeName(). */
  names: readonly string[]
  /** App names to look for, in preference order (English and localized). */
  mac?: readonly string[]
  win?: readonly string[]
  /** Open this site when no app matched (or always, when no app names are given). */
  url?: string
  /** The user's default web browser. */
  browser?: true
  /** Windows command or URI to start when no installed app matched. */
  winFallback?: string
}

export const APP_ALIASES: readonly AppAlias[] = [
  { names: ['калькулятор', 'calculator', 'calc'], mac: ['Calculator', 'Калькулятор'], win: ['Calculator', 'Калькулятор'], winFallback: 'calc.exe' },
  { names: ['телеграм', 'телеграмм', 'телега', 'тг', 'telegram'], mac: ['Telegram', 'Telegram Desktop'], win: ['Telegram', 'Telegram Desktop'] },
  { names: ['хром', 'гугл хром', 'google chrome', 'chrome'], mac: ['Google Chrome'], win: ['Google Chrome', 'Chrome'] },
  { names: ['браузер', 'browser', 'веб браузер', 'интернет', 'internet'], browser: true },
  { names: ['блокнот', 'notepad'], mac: ['TextEdit'], win: ['Notepad', 'Блокнот'], winFallback: 'notepad.exe' },
  { names: ['текстовый редактор', 'textedit', 'text edit'], mac: ['TextEdit'], win: ['Notepad', 'Блокнот', 'WordPad'], winFallback: 'notepad.exe' },
  { names: ['заметки', 'notes'], mac: ['Notes', 'Заметки'], win: ['Sticky Notes', 'Записки', 'OneNote', 'Microsoft OneNote'] },
  { names: ['записки', 'стикеры', 'sticky notes', 'stickies'], mac: ['Stickies', 'Записки'], win: ['Sticky Notes', 'Записки'] },
  {
    names: ['музыка', 'music', 'apple music', 'itunes', 'айтюнс'],
    mac: ['Music', 'Музыка', 'iTunes'],
    win: ['Media Player', 'Медиаплеер', 'Groove Music', 'Музыка Groove', 'Apple Music', 'iTunes', 'Spotify']
  },
  { names: ['почта', 'mail', 'email', 'e mail', 'имейл', 'емейл'], mac: ['Mail', 'Почта'], win: ['Outlook', 'Mail', 'Почта'] },
  { names: ['терминал', 'terminal', 'консоль', 'console'], mac: ['Terminal', 'Терминал', 'iTerm'], win: ['Windows Terminal', 'Terminal', 'Терминал', 'Windows PowerShell'], winFallback: 'wt.exe' },
  { names: ['командная строка', 'command prompt', 'cmd'], mac: ['Terminal', 'Терминал'], win: ['Command Prompt', 'Командная строка'], winFallback: 'cmd.exe' },
  { names: ['powershell', 'пауэршелл', 'повершелл'], mac: ['Terminal'], win: ['Windows PowerShell', 'PowerShell'], winFallback: 'powershell.exe' },
  {
    names: ['проводник', 'explorer', 'file explorer', 'файлы', 'мой компьютер', 'этот компьютер', 'my computer'],
    mac: ['Finder'],
    win: ['File Explorer', 'Проводник'],
    winFallback: 'explorer.exe'
  },
  { names: ['финдер', 'finder', 'файндер'], mac: ['Finder'], win: ['File Explorer', 'Проводник'], winFallback: 'explorer.exe' },
  {
    names: ['настройки', 'параметры', 'системные настройки', 'settings', 'system settings', 'preferences', 'system preferences'],
    mac: ['System Settings', 'Системные настройки', 'System Preferences'],
    win: ['Settings', 'Параметры'],
    winFallback: 'ms-settings:'
  },
  { names: ['панель управления', 'control panel'], win: ['Control Panel', 'Панель управления'], mac: ['System Settings', 'Системные настройки'], winFallback: 'control.exe' },
  {
    names: ['диспетчер задач', 'task manager', 'мониторинг системы', 'activity monitor'],
    mac: ['Activity Monitor', 'Мониторинг системы'],
    win: ['Task Manager', 'Диспетчер задач'],
    winFallback: 'taskmgr.exe'
  },
  { names: ['ворд', 'word', 'майкрософт ворд', 'microsoft word'], mac: ['Microsoft Word'], win: ['Word', 'Microsoft Word'], winFallback: 'winword.exe' },
  { names: ['эксель', 'excel', 'иксель', 'майкрософт эксель', 'microsoft excel'], mac: ['Microsoft Excel'], win: ['Excel', 'Microsoft Excel'], winFallback: 'excel.exe' },
  {
    names: ['пауэрпоинт', 'пауэр поинт', 'поверпоинт', 'повер поинт', 'powerpoint', 'power point'],
    mac: ['Microsoft PowerPoint'],
    win: ['PowerPoint', 'Microsoft PowerPoint'],
    winFallback: 'powerpnt.exe'
  },
  { names: ['аутлук', 'outlook'], mac: ['Microsoft Outlook'], win: ['Outlook', 'Microsoft Outlook'] },
  { names: ['ван ноут', 'уан ноут', 'onenote', 'one note'], mac: ['Microsoft OneNote'], win: ['OneNote', 'Microsoft OneNote'] },
  { names: ['тимс', 'teams', 'microsoft teams'], mac: ['Microsoft Teams'], win: ['Microsoft Teams', 'Teams'] },
  { names: ['вотсап', 'ватсап', 'вацап', 'вотсапп', 'ватсапп', 'whatsapp', 'whats app'], mac: ['WhatsApp'], win: ['WhatsApp'], url: 'https://web.whatsapp.com' },
  { names: ['дискорд', 'discord'], mac: ['Discord'], win: ['Discord'] },
  { names: ['зум', 'zoom'], mac: ['zoom.us', 'Zoom'], win: ['Zoom', 'Zoom Workplace'] },
  { names: ['слак', 'слэк', 'slack'], mac: ['Slack'], win: ['Slack'] },
  { names: ['спотифай', 'spotify'], mac: ['Spotify'], win: ['Spotify'], url: 'https://open.spotify.com' },
  { names: ['скайп', 'skype'], mac: ['Skype'], win: ['Skype'] },
  { names: ['фото', 'фотографии', 'photos'], mac: ['Photos', 'Фото'], win: ['Photos', 'Фотографии', 'Microsoft Photos'] },
  { names: ['календарь', 'calendar'], mac: ['Calendar', 'Календарь'], win: ['Calendar', 'Календарь', 'Outlook'] },
  { names: ['ютуб', 'ютюб', 'youtube'], url: 'https://www.youtube.com' },
  { names: ['вконтакте', 'вк', 'vk', 'vkontakte'], url: 'https://vk.com' },
  { names: ['инстаграм', 'инста', 'instagram'], url: 'https://www.instagram.com' },
  { names: ['гмейл', 'джимейл', 'gmail'], url: 'https://mail.google.com' },
  { names: ['чатгпт', 'чат гпт', 'chatgpt', 'chat gpt'], mac: ['ChatGPT'], win: ['ChatGPT'], url: 'https://chatgpt.com' },
  { names: ['сафари', 'safari'], mac: ['Safari'] },
  { names: ['файрфокс', 'фаерфокс', 'мозилла', 'firefox', 'mozilla'], mac: ['Firefox'], win: ['Firefox', 'Mozilla Firefox'] },
  { names: ['эдж', 'edge', 'microsoft edge'], mac: ['Microsoft Edge'], win: ['Microsoft Edge', 'Edge'], winFallback: 'microsoft-edge:' },
  { names: ['яндекс', 'яндекс браузер', 'yandex', 'yandex browser'], mac: ['Yandex', 'Яндекс Браузер', 'Yandex Browser'], win: ['Yandex', 'Яндекс Браузер', 'Yandex Browser'] },
  { names: ['яндекс музыка', 'yandex music'], mac: ['Яндекс Музыка', 'Yandex Music'], win: ['Яндекс Музыка', 'Yandex Music'], url: 'https://music.yandex.ru' },
  { names: ['опера', 'opera'], mac: ['Opera', 'Opera GX'], win: ['Opera', 'Opera GX', 'Opera Browser'] },
  {
    names: ['вс код', 'вскод', 'визуал студио код', 'vs code', 'vscode', 'visual studio code'],
    mac: ['Visual Studio Code', 'Code'],
    win: ['Visual Studio Code', 'Code']
  },
  { names: ['пейнт', 'paint', 'паинт'], win: ['Paint'], mac: ['Preview'], winFallback: 'mspaint.exe' },
  { names: ['ножницы', 'snipping tool', 'скриншотер'], win: ['Snipping Tool', 'Ножницы', 'Snip & Sketch'], mac: ['Screenshot', 'Снимок экрана'], winFallback: 'snippingtool.exe' },
  { names: ['сообщения', 'messages', 'imessage', 'аймесседж'], mac: ['Messages', 'Сообщения'] },
  { names: ['фейстайм', 'facetime'], mac: ['FaceTime'] },
  { names: ['карты', 'maps'], mac: ['Maps', 'Карты'], win: ['Maps', 'Карты'] },
  { names: ['часы', 'будильник', 'таймер', 'clock', 'alarms'], mac: ['Clock', 'Часы'], win: ['Clock', 'Часы', 'Alarms & Clock', 'Будильники и часы'] },
  { names: ['напоминания', 'reminders'], mac: ['Reminders', 'Напоминания'], win: ['Microsoft To Do', 'To Do'] },
  { names: ['контакты', 'contacts'], mac: ['Contacts', 'Контакты'], win: ['People', 'Люди'] },
  { names: ['просмотр', 'превью', 'preview'], mac: ['Preview', 'Просмотр'], win: ['Photos', 'Фотографии'] },
  { names: ['магазин', 'апстор', 'ап стор', 'app store', 'microsoft store', 'store'], mac: ['App Store'], win: ['Microsoft Store', 'Store'], winFallback: 'ms-windows-store:' },
  { names: ['камера', 'camera', 'photo booth'], mac: ['Photo Booth'], win: ['Camera', 'Камера'], winFallback: 'microsoft.windows.camera:' },
  { names: ['погода', 'weather'], mac: ['Weather', 'Погода'], win: ['Weather', 'Погода', 'MSN Weather'] },
  {
    names: ['плеер', 'видеоплеер', 'медиаплеер', 'quicktime', 'video player', 'media player'],
    mac: ['QuickTime Player'],
    win: ['Media Player', 'Медиаплеер', 'Movies & TV', 'Кино и ТВ', 'Windows Media Player']
  },
  { names: ['книги', 'books'], mac: ['Books', 'Книги'] },
  { names: ['подкасты', 'podcasts'], mac: ['Podcasts', 'Подкасты'], win: ['Spotify'] },
  { names: ['пароли', 'passwords', 'связка ключей', 'keychain'], mac: ['Passwords', 'Пароли', 'Keychain Access'] },
  { names: ['стим', 'steam'], mac: ['Steam'], win: ['Steam'] },
  { names: ['блендер', 'blender'], mac: ['Blender'], win: ['Blender'] },
  { names: ['курсор', 'cursor'], mac: ['Cursor'], win: ['Cursor'] }
]

const FILLER = /^(приложение|приложения|программу|программа|прогу|app|application)\s+/

const INDEX = new Map<string, AppAlias>()
for (const alias of APP_ALIASES) {
  for (const name of alias.names) INDEX.set(normalizeName(name), alias)
}

/** Alias entry for a spoken app name ("приложение телеграм" -> Telegram). */
export function findAppAlias(query: string): AppAlias | undefined {
  const norm = normalizeName(query).replace(FILLER, '')
  return INDEX.get(norm)
}

/** Query variants to match against installed apps: the text itself plus alias targets. */
export function appQueryVariants(query: string, platform: NodeJS.Platform): string[] {
  const variants = [query, normalizeName(query).replace(FILLER, '')]
  const alias = findAppAlias(query)
  const targets = platform === 'darwin' ? alias?.mac : alias?.win
  if (targets) variants.push(...targets)
  return [...new Set(variants.filter(Boolean))]
}
