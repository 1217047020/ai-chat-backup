import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard } from '../../src/ui/Dashboard';

const root = document.getElementById('root');
if (!root) throw new Error('Popup root element is missing');

createRoot(root).render(
  <StrictMode>
    <Dashboard compact />
  </StrictMode>,
);

