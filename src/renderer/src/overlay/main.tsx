import { createRoot } from 'react-dom/client'
import '../common/fonts'
import '../common/theme.css'
import './overlay.css'
import { apiAvailable } from '../common/api'
import { Overlay } from './Overlay'

const root = document.getElementById('root')
if (root && apiAvailable) createRoot(root).render(<Overlay />)
