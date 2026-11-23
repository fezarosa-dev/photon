// Tela do PC: calibração (arquivo escolhido) ou teste automático (/teste) em tela cheia.
import { CONFIGS, FH, FW, FLAG_DEFLATE, TEST_FPS, TYPE_CALIB, TYPE_DATA, TYPE_TEST, render } from './frame.ts';
import { RATES, makePlan, makeSender, maybeDeflate } from './transfer.ts';
import { BACK, ICON, segValue, segmented, wireBack } from './ui.ts';

const FRAMES_PER_CONFIG = 6;   // calibração: imagens seguidas por nível
const TEST_BLOCK = 20;         // teste: imagens por bloco (mesmo fps e nível); ciclo ~36 s

type Meta = { name: string; size: number; sha: Uint8Array; rate?: number; flags?: number; plen?: number };
type Pick = (frame: number) => { config: number; fps: number };
type Content = (frame: number) => Uint8Array;

const SCREEN = '<canvas id="screen"></canvas>';
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
      <div class="row"><span class="label grow">Imagens/s</span>${segmented('fps', [10, 15, 20, 30].map((f) => [f, String(f)]), 20)}</div>
      <div class="row"><button class="btn secondary block" id="calib" disabled>Calibrar</button></div>
    </div>
    <p class="footnote">O celular mostra o nível e a paridade. Esc sai da tela cheia.</p>

    <div class="section">Transferência</div>
    <div class="surface card">
      <div class="row"><span class="label grow">Nível</span>${segmented('level', CONFIGS.map((_, i) => [i, String(i + 1)]), 7)}</div>
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
    info.textContent = `${(f.size / 1024 / 1024).toFixed(1)} MB`;
    calib.disabled = false;
    prepare();
  }
  fileIn.onchange = () => { const f = fileIn.files?.[0]; if (f) load(f); };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files[0]; if (f) load(f); };

  calib.onclick = () => {
    const f = fps();
    play(screen, file!, session, TYPE_CALIB, (n) => ({ config: Math.floor(n / FRAMES_PER_CONFIG) % CONFIGS.length, fps: f }));
  };
  start.onclick = () => {
    if (!ready) return;
    const { meta, content, config } = ready, f = fps();
    play(screen, meta, session, TYPE_DATA, () => ({ config, fps: f }), content);
  };
}

export function mountTest(root: HTMLElement) {
  const blocks = CONFIGS.length * TEST_FPS.length;
  const cycle = CONFIGS.length * TEST_BLOCK * TEST_FPS.reduce((s, f) => s + 1 / f, 0);
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
