import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // ../dashboard has its own node_modules (for its tests): always use this app's single copy.
  resolve: { dedupe: ['react', 'react-dom', 'firebase'] },
  // two pages: the staff dashboard (/) and the customer chat (/chat/{tenantId})
  build: { rollupOptions: { input: { main: 'index.html', chat: 'chat.html' } } },
});
