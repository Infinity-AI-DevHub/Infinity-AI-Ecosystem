import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { isDesktop } from './lib/desktop'

if (isDesktop) {
  document.documentElement.dataset.surface = 'desktop'
  // The desktop visual system is light only (color-scheme: light in desktop.css). Without
  // this, a Mac in dark mode switched the shared tokens to dark under a light canvas and
  // headings became unreadable.
  document.documentElement.dataset.theme = 'light'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
