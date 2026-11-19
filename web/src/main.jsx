import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import PromptPage from './web-ui/PromptPage.jsx'
import './styles.css'

if (new URLSearchParams(window.location.search).get('desktop') === 'orb') {
  document.documentElement.dataset.desktop = 'orb'
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {window.location.pathname === '/prompts' ? <PromptPage /> : <App />}
  </StrictMode>,
)
