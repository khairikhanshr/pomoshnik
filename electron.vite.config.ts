import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve('src/shared')

// Cross-origin isolation lets onnxruntime-web use multi-threaded WASM
// (SharedArrayBuffer) in the voice engine. The production app:// protocol
// handler sends the same headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp'
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    publicDir: resolve('src/renderer/public'),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve('src/renderer/src')
      },
      // Use onnxruntime-web's build that loads its WASM from the copied public/ort* files
      // instead of Vite emitting a second ~27 MB copy into assets/.
      conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production']
    },
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
    worker: { format: 'es' },
    optimizeDeps: {
      exclude: ['onnxruntime-web', '@huggingface/transformers', '@ricky0123/vad-web']
    },
    build: {
      target: 'esnext',
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          overlay: resolve('src/renderer/overlay.html'),
          voice: resolve('src/renderer/voice.html')
        }
      }
    }
  }
})
