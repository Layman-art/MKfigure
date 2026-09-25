import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({ root: 'src/renderer', base: './', plugins: [react()], build: { outDir: path.resolve('dist/renderer'), emptyOutDir: true }, server: { host: '127.0.0.1', port: 5173, strictPort: true } });
