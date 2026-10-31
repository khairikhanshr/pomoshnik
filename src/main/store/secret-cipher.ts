// Ciphers for the SecretStore. The SecretStore API is synchronous, so the synchronous safeStorage
// functions are used (still supported in Electron 45).
import { safeStorage } from 'electron'
import type { SecretCipher } from './secrets'

export function createSafeStorageCipher(): SecretCipher {
  return {
    isAvailable() {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (data) => safeStorage.decryptString(data)
  }
}

/** No OS encryption (E2E runs must not touch the Keychain): values are stored with the "plain:" prefix. */
export const plainCipher: SecretCipher = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error('encryption disabled')
  },
  decrypt: () => {
    throw new Error('encryption disabled')
  }
}
