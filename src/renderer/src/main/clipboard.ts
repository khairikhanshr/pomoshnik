import { S } from '../common/strings'
import { toast } from './state/ui'

/** Copies text; shows a toast unless the caller renders its own feedback. */
export async function copyText(text: string, notify = true): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    if (notify) toast(S.common.copied, 'success')
    return true
  } catch {
    toast(S.common.unknownError, 'error')
    return false
  }
}
