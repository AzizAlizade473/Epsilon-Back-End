import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import './styles/theme.css';
import './styles/app.css';
import './i18n';
import { initTheme } from './lib/theme';
import App from './App';

initTheme();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
