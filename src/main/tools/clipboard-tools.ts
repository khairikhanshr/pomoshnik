import { clipboard } from 'electron'
import { LIMITS } from '@shared/defaults'
import { clip, reqEnum, reqString } from './args'
import { ok, type ToolDef } from './define'

const MAX_READ = LIMITS.maxToolOutputChars - 200

export function clipboardTools(): ToolDef[] {
  const tool: ToolDef = {
    spec: {
      name: 'clipboard',
      description: 'Read the text on the clipboard, or put text on it (action "write" with text).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write'] },
          text: { type: 'string', description: 'Text to copy (for write).' }
        },
        required: ['action'],
        additionalProperties: false
      }
    },
    platforms: ['darwin', 'win32', 'linux'],
    title: (args) => (args.action === 'write' ? 'Копирую в буфер обмена' : 'Читаю буфер обмена'),
    run: async (args) => {
      const action = reqEnum(args, 'action', ['read', 'write'] as const)
      if (action === 'write') {
        const text = reqString(args, 'text', { raw: true, max: 1_000_000 })
        await clipboard.writeText(text)
        return ok(`Copied ${text.length} characters to the clipboard.`, `Скопировано: ${clip(text, 40)}`)
      }
      const text = await clipboard.readText()
      if (!text) {
        if (await clipboard.has('image/png').catch(() => false)) return ok('The clipboard holds an image, no text.', 'В буфере изображение')
        return ok('The clipboard is empty.', 'Буфер обмена пуст')
      }
      const body = text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n[truncated: ${text.length} characters in total]` : text
      return ok(`Clipboard text (${text.length} characters):\n---\n${body}`, `В буфере: ${clip(text, 40)}`)
    }
  }
  return [tool]
}
