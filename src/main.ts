const app = document.getElementById('app')!;
const route = location.pathname.replace(/\/+$/, '') === '/teste' ? 'teste' : location.hash.slice(1);

if (route === 'enviar') import('./send.ts').then((m) => m.mountSend(app));
else if (route === 'receber') import('./receive.ts').then((m) => m.mountReceive(app));
else if (route === 'teste') {
  app.innerHTML = `
    <h1>Teste automático</h1>
    <p>Abra esta mesma página nos dois aparelhos.</p>
    <p><button id="pc" disabled>Teste automático (PC)</button>
       <button id="cel" disabled>Teste automático (celular)</button></p>`;
  // módulos carregados antes do clique: abrir a câmera precisa acontecer dentro do gesto
  Promise.all([import('./send.ts'), import('./receive.ts')]).then(([send, recv]) => {
    const pc = app.querySelector<HTMLButtonElement>('#pc')!, cel = app.querySelector<HTMLButtonElement>('#cel')!;
    pc.onclick = () => send.mountTest(app);
    cel.onclick = () => recv.mountReceive(app, true);
    pc.disabled = cel.disabled = false;
  });
} else app.innerHTML = `
  <h1>qrFI</h1>
  <p>Transferência de arquivos pela luz: a tela de um aparelho e a câmera do outro. Sem rede, sem cabo.</p>
  <p><a class="btn" href="#enviar">Enviar (PC)</a> <a class="btn" href="#receber">Receber (celular)</a>
     <a class="btn" href="/teste">Teste automático</a></p>`;

addEventListener('hashchange', () => location.reload()); // libera câmera/tela cheia ao trocar de papel
