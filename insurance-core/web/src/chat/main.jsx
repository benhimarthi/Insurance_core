import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatApp } from './ChatApp.jsx';
import { createAppCheckTokenGetter } from './appCheck.js';
import './chat.css';

// /chat/{tenantId}[?demo=1][&key=...][&lang=en]
const params = new URLSearchParams(window.location.search);
const tenantId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] || '');
const lang = params.get('lang') === 'en' || (!params.get('lang') && /^en\b/.test(navigator.language || '')) ? 'en' : 'fr';
document.documentElement.lang = lang;

const getAppCheckToken = await createAppCheckTokenGetter(import.meta.env.VITE_RECAPTCHA_SITE_KEY).catch(() => null);

createRoot(document.getElementById('chat-root')).render(
  <StrictMode>
    {/^[a-z0-9][a-z0-9-]{2,39}$/.test(tenantId)
      ? <ChatApp tenantId={tenantId} lang={lang} demo={params.has('demo')} apiKey={params.get('key')} getAppCheckToken={getAppCheckToken} />
      : <p className="chat-missing">Lien de chat invalide.</p>}
  </StrictMode>,
);
