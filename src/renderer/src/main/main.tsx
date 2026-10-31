import { createRoot } from 'react-dom/client'
import '../common/fonts'
import '../common/theme.css'
import './styles/ui.css'
import './styles/app.css'
import './styles/chat.css'
import './styles/markdown.css'
import './styles/composer.css'
import './styles/settings.css'
import { api, apiAvailable } from '../common/api'
import { S } from '../common/strings'
import { App } from './App'

const root = document.getElementById('root')
if (root) {
  document.documentElement.dataset.platform = apiAvailable ? api.platform : 'darwin'
  createRoot(root).render(
    apiAvailable ? (
      <App />
    ) : (
      <div className="splash" role="alert">
        <p className="splash-text">{S.app.noBridge}</p>
      </div>
    )
  )
}
