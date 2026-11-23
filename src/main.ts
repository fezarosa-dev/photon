import './style.css';
import { ICON } from './ui.ts';

const app = document.getElementById('app')!;
const test = location.pathname.replace(/\/+$/, '') === '/teste';
if (location.hash) history.replaceState(null, '', location.pathname); // links antigos (#enviar/#receber) caem no início

const tile = (href: string, ico: string, cls: string, title: string, text: string, id = '') =>
  `<a class="tile surface" href="${href}"${id ? ` id="${id}"` : ''}><span class="ico ${cls}">${ico}</span><b>${title}</b><small>${text}</small></a>`;

if (test) {
  app.innerHTML = `
    <h1>Teste automático</h1>
    <p class="subtitle">Abra nos dois aparelhos.</p>
    <div class="tiles">
      ${tile('#', ICON.send, '', 'No PC', 'Mostra as combinações na tela.', 'pc')}
      ${tile('#', ICON.receive, 'g', 'No celular', 'Lê com a câmera e guia você.', 'cel')}
    </div>`;
  // módulos carregados antes do toque: abrir a câmera precisa acontecer dentro do gesto
  Promise.all([import('./send.ts'), import('./receive.ts')]).then(([send, recv]) => {
    app.querySelector<HTMLElement>('#pc')!.onclick = (e) => { e.preventDefault(); send.mountTest(app); };
    app.querySelector<HTMLElement>('#cel')!.onclick = (e) => { e.preventDefault(); recv.mountReceive(app, true); };
  });
} else {
  app.innerHTML = `
  <h1>qrFI</h1>
  <p class="subtitle">Arquivos pela luz. Sem rede, sem cabo.</p>
  <div class="tiles">
    ${tile('#', ICON.send, '', 'Enviar', 'No computador.', 'send')}
    ${tile('#', ICON.receive, 'g', 'Receber', 'No celular.', 'recv')}
  </div>`;
  // módulos carregados antes do toque: abrir a câmera precisa acontecer dentro do gesto
  Promise.all([import('./send.ts'), import('./receive.ts')]).then(([send, recv]) => {
    app.querySelector<HTMLElement>('#send')!.onclick = (e) => { e.preventDefault(); send.mountSend(app); };
    app.querySelector<HTMLElement>('#recv')!.onclick = (e) => { e.preventDefault(); recv.mountReceive(app, true); };
  });
}
