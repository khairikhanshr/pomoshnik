// Application menu: macOS needs one for the standard Edit shortcuts (copy / paste in text fields);
// Windows and Linux use the custom title bar, so packaged builds have no menu bar at all.
import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from './version'

export function setupApplicationMenu(platform: NodeJS.Platform, onSettings: () => void): void {
  if (platform !== 'darwin') {
    if (app.isPackaged) Menu.setApplicationMenu(null)
    return
  }
  const name = APP_NAME
  const template: MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { role: 'about', label: `О программе ${name}` },
        { type: 'separator' },
        { label: 'Настройки…', accelerator: 'Command+,', click: onSettings },
        { type: 'separator' },
        { role: 'hide', label: `Скрыть ${name}` },
        { role: 'hideOthers', label: 'Скрыть остальные' },
        { role: 'unhide', label: 'Показать все' },
        { type: 'separator' },
        { role: 'quit', label: `Завершить ${name}` }
      ]
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Скопировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выбрать все' }
      ]
    },
    ...(app.isPackaged
      ? []
      : [
          {
            label: 'Вид',
            submenu: [
              { role: 'reload', label: 'Перезагрузить' },
              { role: 'toggleDevTools', label: 'Инструменты разработчика' }
            ] as MenuItemConstructorOptions[]
          }
        ]),
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize', label: 'Свернуть' },
        { role: 'zoom', label: 'Изменить масштаб' },
        { role: 'close', label: 'Закрыть окно' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
