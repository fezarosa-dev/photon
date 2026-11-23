// Tela do PC: calibração (arquivo escolhido) ou teste automático (/teste) em tela cheia.
import { CONFIGS, FH, FW, FLAG_DEFLATE, TEST_FPS, TYPE_CALIB, TYPE_DATA, TYPE_TEST, hex, kbps, render } from './frame.ts';
import { RATES, makePlan, makeSender, maybeDeflate } from './transfer.ts';

const FRAMES_PER_CONFIG = 6;   // calibração: imagens seguidas por nível
const TEST_BLOCK = 20;         // teste: imagens por bloco (mesmo fps e nível); ciclo ~36 s

type Meta = { name: string; size: number; sha: Uint8Array; rate?: number; flags?: number; plen?: number };
type Pick = (frame: number) => { config: number; fps: number };
type Content = (frame: number) => Uint8Array;

const SCREEN = '<canvas id="screen"></canvas>';
const newSession = () => crypto.getRandomValues(new Uint32Array(1))[0];

export function mountSend(root: HTMLElement) {
  root.innerHTML = `
    <h1>Enviar</h1>
    <ol>
      <li>Escolha o arquivo.</li>
      <li>Clique em <b>Calibrar</b> e aponte o celular para a tela até ele mostrar <b>Calibrado</b>.</li>
      <li>Saia da tela cheia (Esc), escolha o nível indicado pelo celular e inicie.</li>
    </ol>
    <p><label>Arquivo <input type="file" id="file"></label></p>
    <p id="info" class="mono"></p>
    <p><label>Imagens por segundo
      <select id="fps">${[30, 20, 15, 10].map((f) => `<option${f === 20 ? ' selected' : ''}>${f}</option>`).join('')}</select>
    </label></p>
    <p><button id="calib" disabled>Calibrar (tela cheia)</button></p>
    <p><label>Nível <select id="level"></select></label>
      <label>Paridade <select id="rate">${RATES.map((r) => `<option value="${r}"${r === 0.75 ? ' selected' : ''}>${Math.round((1 - r) * 100)}%</option>`).join('')}</select></label></p>
    <p><button id="start" disabled>Iniciar transferência (tela cheia)</button> <span id="plan" class="mono"></span></p>
    ${SCREEN}`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const fileIn = $<HTMLInputElement>('file'), info = $('info'), fpsSel = $<HTMLSelectElement>('fps');
  const calib = $<HTMLButtonElement>('calib'), level = $<HTMLSelectElement>('level'), screen = $<HTMLCanvasElement>('screen');
  const rateSel = $<HTMLSelectElement>('rate'), start = $<HTMLButtonElement>('start'), planInfo = $('plan');

  const fillLevels = () => {
    const fps = Number(fpsSel.value);
    level.innerHTML = CONFIGS.map((c, i) =>
      `<option value="${i}">${i + 1}: célula ${c.cell}px, ${c.colors} cores, ~${kbps(c, fps).toFixed(0)} KB/s</option>`).join('');
  };
  fillLevels();

  let file: Meta | null = null, bytes: Uint8Array | null = null, session = 0;
  let ready: { meta: Meta; content: Content; config: number } | null = null;

  // prepara a transferência fora do clique (comprimir + montar o LDPC custa); o clique só abre a tela cheia
  async function prepare() {
    ready = null;
    start.disabled = true;
    if (!file || !bytes) return;
    const config = Number(level.value), rate = Number(rateSel.value);
    planInfo.textContent = 'preparando…';
    const { bytes: payload, deflated } = await maybeDeflate(bytes);
    const plan = makePlan(config, rate), sender = makeSender(payload, plan);
    ready = { config, content: (f) => sender.symbols(f), meta: { ...file, rate, flags: deflated ? FLAG_DEFLATE : 0, plen: payload.length } };
    const perFrame = plan.m * plan.packetSize, fps = Number(fpsSel.value);
    planInfo.textContent = `${sender.k} pacotes de ${plan.packetSize} B${deflated ? ` · comprimido ${Math.round((100 * payload.length) / bytes.length)}%` : ''}`
      + ` · ${(perFrame / 1024).toFixed(1)} KB/imagem · ~${Math.ceil((payload.length * 1.08) / perFrame / fps)} s sem perdas`;
    start.disabled = false;
  }
  fpsSel.onchange = () => { fillLevels(); prepare(); };
  level.onchange = rateSel.onchange = prepare;
  fileIn.onchange = async () => {
    const f = fileIn.files?.[0];
    if (!f) return;
    if (!crypto.subtle) { info.textContent = 'SHA-256 indisponível: abra a página por https:// ou localhost.'; return; }
    calib.disabled = true;
    info.textContent = 'Calculando SHA-256…';
    const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()));
    bytes = new Uint8Array(await f.arrayBuffer());
    file = { name: f.name, size: f.size, sha };
    session = newSession();
    info.textContent = `${f.name} · ${f.size.toLocaleString('pt-BR')} bytes · SHA-256 ${hex(sha)}`;
    calib.disabled = false;
    prepare();
  };

  calib.onclick = () => {
    const fps = Number(fpsSel.value);
    play(screen, file!, session, TYPE_CALIB, (f) => ({ config: Math.floor(f / FRAMES_PER_CONFIG) % CONFIGS.length, fps }));
  };
  start.onclick = () => {
    if (!ready) return;
    const { meta, content, config } = ready, fps = Number(fpsSel.value);
    play(screen, meta, session, TYPE_DATA, () => ({ config, fps }), content);
  };
}

export function mountTest(root: HTMLElement) {
  const blocks = CONFIGS.length * TEST_FPS.length;
  const cycle = CONFIGS.length * TEST_BLOCK * TEST_FPS.reduce((s, f) => s + 1 / f, 0);
  root.innerHTML = `
    <h1>Teste automático</h1>
    <p>Varre os ${CONFIGS.length} níveis × ${TEST_FPS.join(' / ')} imagens/s, com ${TEST_BLOCK} imagens por combinação
      (${blocks} combinações, ciclo de ~${Math.round(cycle)} s), em loop até você apertar <b>Esc</b>.</p>
    <ol>
      <li>No celular: <b>Receber</b> em <b>1080p</b> → Abrir câmera.</li>
      <li>Aqui: <b>Iniciar teste</b>.</li>
      <li>Siga a instrução no celular (Aproxime / Afaste / Fique parado) até 100%.</li>
      <li>As planilhas chegam sozinhas na pasta <code>relatorios/</code> do PC.</li>
    </ol>
    <p><button id="go">Iniciar teste (tela cheia)</button></p>
    ${SCREEN}`;
  const screen = root.querySelector<HTMLCanvasElement>('#screen')!;
  root.querySelector<HTMLButtonElement>('#go')!.onclick = () =>
    play(screen, { name: 'teste', size: 0, sha: new Uint8Array(32) }, newSession(), TYPE_TEST, (f) => {
      const b = Math.floor(f / TEST_BLOCK) % blocks; // nível por fora, fps por dentro: mesma distância p/ os 3 fps
      return { config: Math.floor(b / TEST_FPS.length), fps: TEST_FPS[b % TEST_FPS.length] };
    });
}

let running = false;

async function play(screen: HTMLCanvasElement, meta: Meta, session: number, type: number, pick: Pick, content?: Content) {
  screen.style.display = 'block';
  try { await screen.requestFullscreen(); } catch { screen.style.display = 'none'; return; }
  document.onfullscreenchange = () => {
    if (!document.fullscreenElement) { running = false; screen.style.display = 'none'; }
  };
  screen.width = Math.round(screen.clientWidth * devicePixelRatio);
  screen.height = Math.round(screen.clientHeight * devicePixelRatio);
  const ctx = screen.getContext('2d')!;
  const off = document.createElement('canvas');
  off.width = FW; off.height = FH;
  const octx = off.getContext('2d')!, img = octx.createImageData(FW, FH), px = new Uint32Array(img.data.buffer);

  // 1:1 se couber (células nítidas); escala inteira se sobrar; fracionária só em tela menor que 1920×1080
  let s = Math.min(screen.width / FW, screen.height / FH);
  if (s >= 1) s = Math.floor(s);
  const w = FW * s, h = FH * s, x = Math.floor((screen.width - w) / 2), y = Math.floor((screen.height - h) / 2);

  let frame = 0, last = -Infinity;
  running = true;
  const tick = (now: number) => {
    if (!running) return;
    const { config, fps } = pick(frame);
    if (now - last >= 1000 / fps - 4) { // troca a cada N vsyncs, sem depender da taxa do monitor
      last = now;
      render(px, { type, config, fps, session, frame, ...meta }, content?.(frame));
      octx.putImageData(img, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, screen.width, screen.height);
      ctx.imageSmoothingEnabled = s < 1;
      ctx.drawImage(off, x, y, w, h);
      frame++;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
