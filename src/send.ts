// Tela do PC: calibração (arquivo escolhido) ou teste automático (/teste) em tela cheia.
import { COARSE, FH, FINE, FW, FLAG_DEFLATE, TEST_FPS, TYPE_CALIB, TYPE_DATA, TYPE_TEST, render } from './frame.ts';
import { RATES, makePlan, makeSender, maybeDeflate } from './transfer.ts';
import { BACK, ICON, formatBytes, segValue, segmented, wireBack } from './ui.ts';

const FRAMES_PER_CONFIG = 6;   // calibração: imagens seguidas por nível
const TEST_BLOCK = 20;         // teste: imagens por bloco (mesmo fps e nível); ciclo ~36 s

type Meta = { name: string; size: number; sha: Uint8Array; rate?: number; flags?: number; plen?: number };
type Pick = (frame: number) => { config: number; fps: number };
type Content = (frame: number) => Uint8Array;

const SCREEN = '<canvas id="screen"></canvas>';
// celular enviando: a webcam do PC costuma rodar a 30 fps → 15 imagens/s respeita a regra dos 2×
const PHONE = matchMedia('(pointer: coarse)').matches;
// celular enviando: níveis grossos (células grandes) para a webcam conseguir ler a tela pequena
const LEVELS = PHONE ? COARSE : FINE;
const newSession = () => crypto.getRandomValues(new Uint32Array(1))[0];

export function mountSend(root: HTMLElement) {
  root.innerHTML = `
    ${BACK}
    <h1>Enviar</h1>
    <p class="subtitle">Pela tela, sem rede.</p>

    <div class="section">Arquivo</div>
    <div class="surface card">
      <label class="drop" id="drop">
        <input type="file" id="file">
        ${ICON.doc}
        <strong id="fname">Escolher ou soltar um arquivo</strong>
        <span class="mono" id="info"></span>
      </label>
    </div>

    <div class="section">Calibração</div>
    <div class="surface card">
      <div class="row"><span class="label grow">Imagens/s</span>${segmented('fps', [10, 15, 20, 30].map((f) => [f, String(f)]), PHONE ? 15 : 20)}</div>
      <div class="row"><button class="btn secondary block" id="calib" disabled>Calibrar</button></div>
    </div>
    <p class="footnote">${PHONE ? 'Brilho no máximo. O PC mostra o nível e a paridade. Toque para parar.' : 'O celular mostra o nível e a paridade. Esc sai da tela cheia.'}</p>

    <div class="section">Transferência</div>
    <div class="surface card">
      <div class="row"><span class="label grow">Nível</span>${segmented('level', LEVELS.map((c, i) => [c, String(i + 1)]), PHONE ? COARSE[2] : 7)}</div>
      <div class="row"><span class="label grow">Paridade</span>${segmented('rate', RATES.map((r) => [r, `${Math.round((1 - r) * 100)}%`]), 0.75)}</div>
      <div class="row"><button class="btn grow" id="start" disabled>Iniciar</button><span class="mono" id="plan"></span></div>
    </div>
    ${SCREEN}`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const fileIn = $<HTMLInputElement>('file'), info = $('info'), fname = $('fname'), drop = $('drop');
  const calib = $<HTMLButtonElement>('calib'), screen = $<HTMLCanvasElement>('screen');
  const start = $<HTMLButtonElement>('start'), planInfo = $('plan');
  wireBack(root);
  const fps = () => Number(segValue(root, 'fps')), rate = () => Number(segValue(root, 'rate')), level = () => Number(segValue(root, 'level'));


  let file: Meta | null = null, bytes: Uint8Array | null = null, session = 0;
  let ready: { meta: Meta; content: Content; config: number } | null = null;

  // prepara a transferência fora do clique (comprimir + montar o LDPC custa); o clique só abre a tela cheia
  async function prepare() {
    ready = null;
    start.disabled = true;
    if (!file || !bytes) return;
    const config = level(), r = rate();
    planInfo.textContent = 'preparando…';
    const { bytes: payload, deflated } = await maybeDeflate(bytes);
    const plan = makePlan(config, r), sender = makeSender(payload, plan);
    ready = { config, content: (f) => sender.symbols(f), meta: { ...file, rate: r, flags: deflated ? FLAG_DEFLATE : 0, plen: payload.length } };
    const perFrame = plan.m * plan.packetSize;
    planInfo.textContent = `~${Math.ceil((payload.length * 1.08) / perFrame / fps())} s`;
    start.disabled = false;
  }
  for (const name of ['fps', 'rate', 'level']) root.querySelector(`input[name="${name}"]`)!.closest('.seg')!.addEventListener('change', prepare);

  async function load(f: File) {
    if (!crypto.subtle) { info.textContent = 'SHA-256 indisponível: abra a página por https:// ou localhost.'; return; }
    calib.disabled = true;
    fname.textContent = f.name;
    info.textContent = 'Calculando SHA-256…';
    bytes = new Uint8Array(await f.arrayBuffer());
    const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
    file = { name: f.name, size: f.size, sha };
    session = newSession();
    info.textContent = formatBytes(f.size);
    calib.disabled = false;
    prepare();
  }
  fileIn.onchange = () => { const f = fileIn.files?.[0]; if (f) load(f); };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files[0]; if (f) load(f); };

  calib.onclick = () => {
    const f = fps();
    play(screen, file!, session, TYPE_CALIB, (n) => ({ config: LEVELS[Math.floor(n / FRAMES_PER_CONFIG) % LEVELS.length], fps: f }));
  };
  start.onclick = () => {
    if (!ready) return;
    const { meta, content, config } = ready, f = fps();
    play(screen, meta, session, TYPE_DATA, () => ({ config, fps: f }), content);
  };
}

export function mountTest(root: HTMLElement) {
  const blocks = FINE.length * TEST_FPS.length;
  const cycle = FINE.length * TEST_BLOCK * TEST_FPS.reduce((s, f) => s + 1 / f, 0);
  root.innerHTML = `
    ${BACK}
    <h1>Teste automático</h1>
    <p class="subtitle">Siga as instruções no celular até 100%. Esc encerra.</p>
    <div class="surface card">
      <div class="row"><button class="btn block" id="go">Iniciar teste</button></div>
    </div>
    <p class="footnote">Ciclo de ~${Math.round(cycle)} s · planilhas em <code>relatorios/</code></p>
    ${SCREEN}`;
  wireBack(root);
  const screen = root.querySelector<HTMLCanvasElement>('#screen')!;
  root.querySelector<HTMLButtonElement>('#go')!.onclick = () =>
    play(screen, { name: 'teste', size: 0, sha: new Uint8Array(32) }, newSession(), TYPE_TEST, (f) => {
      const b = Math.floor(f / TEST_BLOCK) % blocks; // nível por fora, fps por dentro: mesma distância p/ os 3 fps
      return { config: FINE[Math.floor(b / TEST_FPS.length)], fps: TEST_FPS[b % TEST_FPS.length] };
    });
}

let running = false;
let wake: WakeLockSentinel | null = null;

async function play(screen: HTMLCanvasElement, meta: Meta, session: number, type: number, pick: Pick, content?: Content) {
  screen.style.display = 'block';
  // iPhone: sem Fullscreen API para páginas → o quadro cobre a área visível e um toque encerra
  let overlay = false;
  try { await screen.requestFullscreen(); } catch { overlay = true; screen.classList.add('overlay'); }
  const stop = () => {
    running = false;
    screen.style.display = 'none';
    screen.classList.remove('overlay');
    wake?.release().catch(() => {});
    wake = null;
  };
  document.onfullscreenchange = () => { if (!document.fullscreenElement && !overlay) stop(); };
  screen.onclick = overlay ? stop : null;
  try { wake = (await navigator.wakeLock?.request('screen')) ?? null; } catch { /* sem Wake Lock: a tela pode apagar */ }

  screen.width = Math.round(screen.clientWidth * devicePixelRatio);
  screen.height = Math.round(screen.clientHeight * devicePixelRatio);
  const ctx = screen.getContext('2d')!;
  const off = document.createElement('canvas');
  off.width = FW; off.height = FH;
  const octx = off.getContext('2d')!, img = octx.createImageData(FW, FH), px = new Uint32Array(img.data.buffer);

  // tela em pé (celular): gira o quadro 90° para usar o lado comprido; giro de 90° mantém o 1:1 dos pixels
  const rotate = screen.height > screen.width;
  const W = rotate ? screen.height : screen.width, Hs = rotate ? screen.width : screen.height;
  // 1:1 se couber (células nítidas); escala inteira se sobrar; fracionária só em tela menor que 1920×1080
  let s = Math.min(W / FW, Hs / FH);
  if (s >= 1) s = Math.floor(s);
  const w = FW * s, h = FH * s, x = Math.floor((W - w) / 2), y = Math.floor((Hs - h) / 2);

  let frame = 0, last = -Infinity;
  running = true;
  const tick = (now: number) => {
    if (!running) return;
    const { config, fps } = pick(frame);
    if (now - last >= 1000 / fps - 4) { // troca a cada N vsyncs, sem depender da taxa do monitor
      last = now;
      render(px, { type, config, fps, session, frame, ...meta }, content?.(frame));
      octx.putImageData(img, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, screen.width, screen.height);
      if (rotate) ctx.setTransform(0, 1, -1, 0, screen.width, 0); // (u, v) → (largura − v, u): 90° horário
      ctx.imageSmoothingEnabled = s < 1;
      ctx.drawImage(off, x, y, w, h);
      frame++;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
