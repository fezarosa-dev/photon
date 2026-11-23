import './style.css';
import { CHEVRON } from './ui.ts';

const app = document.getElementById('app')!;
if (location.hash) history.replaceState(null, '', location.pathname); // links antigos (#enviar/#receber) caem no início

const tile = (title: string, text: string, id: string) =>
  `<a class="tile surface" href="#" id="${id}"><b>${title}</b><small>${text}</small>${CHEVRON}</a>`;

app.innerHTML = `
  <h1>Photon</h1>
  <p class="subtitle">Arquivos pela luz. Sem rede, sem cabo.</p>
  <div class="tiles">
    ${tile('Enviar', 'O arquivo está neste aparelho.', 'send')}
    ${tile('Receber', 'Este aparelho vai receber.', 'recv')}
  </div>`;
// módulos carregados antes do toque: abrir a câmera precisa acontecer dentro do gesto
Promise.all([import('./send.ts'), import('./receive.ts')]).then(([send, recv]) => {
  app.querySelector<HTMLElement>('#send')!.onclick = (e) => { e.preventDefault(); send.mountSend(app); };
  app.querySelector<HTMLElement>('#recv')!.onclick = (e) => { e.preventDefault(); recv.mountReceive(app, true); };
});
