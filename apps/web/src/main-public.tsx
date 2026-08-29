import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import PublicApp from './PublicApp.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PublicApp />
  </StrictMode>,
);
