// Service worker rules: read the comment block at the top of public/tile-sw.js
// before modifying anything here or in that file.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom';
import './index.css'
import App from './App.tsx'

if ('serviceWorker' in navigator) {
  const activateWaiting = (sw: ServiceWorker) => sw.postMessage({ type: 'SKIP_WAITING' });

  navigator.serviceWorker
    .register('/tile-sw.js', { updateViaCache: 'none' })
    .then(registration => {
      registration.update();

      if (registration.waiting) activateWaiting(registration.waiting);

      registration.addEventListener('updatefound', () => {
        const sw = registration.installing!;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && registration.waiting) activateWaiting(registration.waiting);
        });
      });
    });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
       <App />
    </BrowserRouter>
  </StrictMode>,
)
