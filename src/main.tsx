/**
 * Entry point.
 *
 * Deliberately no <StrictMode>: it double-invokes effects in development, which
 * would start two render loops, two satellite workers and two camera streams.
 * The engine is a persistent imperative resource, not a pure render function.
 */

import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/app.css';
import './styles/sheets.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing');

createRoot(container).render(<App />);

// Remove the static boot splash once React has painted its first frame.
requestAnimationFrame(() => {
  const boot = document.getElementById('boot');
  if (boot) {
    boot.style.transition = 'opacity 240ms ease-out';
    boot.style.opacity = '0';
    window.setTimeout(() => boot.remove(), 260);
  }
});
