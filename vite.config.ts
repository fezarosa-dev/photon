import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const MAX_BYTES = 50e6;

// Só em desenvolvimento: o celular grava as planilhas/relatórios de teste em ./relatorios.
// É telemetria do teste, não o canal de dados (esse continua sendo só a luz).
const reports = (): Plugin => ({
  name: 'photon-relatorios',
  configureServer(server) {
    server.middlewares.use('/__relatorio', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      const name = basename(new URL(req.url ?? '', 'http://x').searchParams.get('nome') ?? '').replace(/[^\w.-]/g, '_');
      if (!/^photon-[\w.-]+\.(csv|png)$/.test(name)) { res.statusCode = 400; res.end('nome inválido'); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) { res.statusCode = 413; res.end(); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        mkdirSync('relatorios', { recursive: true });
        writeFileSync(join('relatorios', name), Buffer.concat(chunks));
        res.end('ok');
      });
    });
  },
});

// HTTPS local: o Safari do iPhone só libera a câmera em contexto seguro.
// Build: publicado no GitHub Pages em /photon/ (https de verdade, sem aviso de certificado).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/photon/' : '/',
  plugins: [basicSsl(), reports()],
  server: { host: true },
}));
