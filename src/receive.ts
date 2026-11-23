// Tela do celular: filma, lê cada quadro e mede o erro por nível até declarar "Calibrado".
import { ANCHOR_CENTERS, CONFIGS, TYPE_TEST, decodeFrame, hex, kbps, type Header, type Status } from './frame.ts';
import { createLog } from './log.ts';
import type { Pt } from './detect.ts';

const MIN_FRAMES = 5;   // leituras limpas por nível para considerar medido
const MAX_ERR = 0.05;   // ponytail: erro de símbolo tolerável estimado; recalibrar quando o LDPC existir
const SYNC_MS = 10_000; // envio automático das planilhas ao PC (só no servidor de desenvolvimento)
const LOST_MS = 600;    // só pede para enquadrar depois desse tempo sem ler nenhum quadro
const ACTION_TEXT = {
  pronto: '✅ Pode parar', enquadre: '🔲 Enquadre os 4 cantos', parado: '✋ Fique parado',
  aproxime: '⬆️ Aproxime', afaste: '⬇️ Afaste',
} as const;

/** auto: abre a câmera já (chamado de dentro do clique, que o Safari exige para a câmera). */
export function mountReceive(root: HTMLElement, auto = false) {
  root.innerHTML = `
    <h1>Receber</h1>
    <p>Deite o celular e enquadre a tela inteira do PC.</p>
    <p><label>Resolução <select id="res">
      <option value="1920x1080">1080p</option><option value="2560x1440">1440p</option><option value="3840x2160">4K</option>
    </select></label> <button id="go">Abrir câmera</button></p>
    <div class="view"><video id="v" playsinline muted></video><canvas id="ov"></canvas>
      <p id="verdict" class="verdict" role="status"></p></div>
    <p><button id="csv">📊 Enviar planilha</button> <button id="dbg">📋 Gerar relatório</button><br>
      <small id="sync">As planilhas vão sozinhas para o PC a cada 10 s.</small></p>
    <p id="meta" class="mono"></p>
    <p id="stat" class="mono"></p>
    <table id="tbl"></table>`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const resSel = $<HTMLSelectElement>('res'), go = $<HTMLButtonElement>('go'), video = $<HTMLVideoElement>('v'), ov = $<HTMLCanvasElement>('ov');
  const verdict = $('verdict'), meta = $('meta'), stat = $('stat'), tbl = $('tbl'), dbg = $<HTMLButtonElement>('dbg');
  const csvBtn = $<HTMLButtonElement>('csv'), syncInfo = $('sync');
  const log = createLog();
  let synced = -1;

  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true })!;
  let stats = CONFIGS.map(() => ({ frames: 0, cells: 0, errors: 0 }));
  const count: Record<Status, number> = { 'sem-marcadores': 0, 'sem-cabecalho': 0, misturado: 0, ok: 0 };
  let header: Header | null = null;
  let lastFail: ImageData | null = null, lastOk: ImageData | null = null; // diagnóstico
  let scale = 0, lastStatus: Status = 'sem-marcadores', lastSeen = -Infinity; // lastSeen: último quadro lido (ms)
  const USE_WINDOW = 150;        // janela (em imagens do emissor) para medir o aproveitamento
  let seenFrames: number[] = []; // índices distintos lidos com sucesso, dentro da janela
  let camFrames = 0, procFrames = 0, camFps = 0, procFps = 0, lastPresented = -1, t0 = 0, lastUi = 0;

  const resetStats = () => {
    stats = CONFIGS.map(() => ({ frames: 0, cells: 0, errors: 0 }));
    for (const k in count) count[k as Status] = 0;
    seenFrames = [];
  };

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      verdict.textContent = 'Câmera indisponível: abra a página por https://';
      return;
    }
    (video.srcObject as MediaStream | null)?.getTracks().forEach((tr) => tr.stop());
    const [w, h] = resSel.value.split('x').map(Number);
    try {
      video.srcObject = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 60 } },
      });
      await video.play();
    } catch (e) {
      verdict.textContent = 'Não foi possível abrir a câmera: ' + (e as Error).message;
      return;
    }
    resetStats();
    if (go.hidden) return; // troca de resolução: o laço já está rodando
    go.hidden = true;
    t0 = performance.now();
    schedule();
  }
  go.onclick = start;
  if (auto) start();
  resSel.onchange = () => { if (go.hidden) start(); };

  dbg.onclick = async () => {
    const frames: [string, ImageData][] = [];
    if (lastFail) frames.push(['falha (sem cabeçalho)', lastFail]);
    if (lastOk) frames.push(['ok', lastOk]);
    deliver([await buildReport(reportLines(), frames)]);
  };
  csvBtn.onclick = () => deliver(log.files(reportLines().slice(0, 9)));

  /** Grava no PC (servidor de desenvolvimento); sem servidor, cai no menu de compartilhar. */
  async function upload(files: File[]) {
    for (const f of files) {
      const r = await fetch(`/__relatorio?nome=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }
    syncInfo.textContent = `✔ enviado ao PC ${new Date().toLocaleTimeString('pt-BR')} (${log.count} leituras)`;
  }
  async function deliver(files: File[]) {
    try { await upload(files); return; } catch { /* sem servidor: compartilhar */ }
    if (navigator.canShare?.({ files })) { await navigator.share({ files }).catch(() => {}); return; }
    for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f); a.download = f.name; a.click();
    }
  }
  setInterval(() => {
    if (!go.hidden || log.count === synced) return;
    synced = log.count;
    upload(log.files(reportLines().slice(0, 9))).catch((e) => { syncInfo.textContent = `envio automático falhou: ${(e as Error).message}`; });
  }, SYNC_MS);

  function reportLines() {
    const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    const fps = header?.fps ?? 15;
    return [
      `qrFI relatório · ${new Date().toISOString()}`,
      `ua: ${navigator.userAgent}`,
      `tela ${screen.width}x${screen.height} dpr ${devicePixelRatio}`,
      stat.textContent ?? '',
      meta.textContent ?? '',
      `veredito: ${verdict.textContent}`,
      `sessão ${header ? header.session.toString(16) : '-'} · imagens/s do emissor ${fps} · resolução pedida ${resSel.value}`,
      `settings: ${JSON.stringify(track?.getSettings() ?? {})}`,
      `capabilities: ${JSON.stringify(track?.getCapabilities?.() ?? {})}`,
      'nível | célula | cores | leituras | erro% | KB/s',
      ...CONFIGS.map((c, i) => {
        const s = stats[i];
        return `${i + 1} | ${c.cell}px | ${c.colors} | ${s.frames} | ${s.cells ? ((100 * s.errors) / s.cells).toFixed(2) : '-'} | ${kbps(c, fps).toFixed(0)}`;
      }),
    ];
  }

  const rvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const schedule = () => rvfc ? video.requestVideoFrameCallback(onFrame) : requestAnimationFrame((t) => onFrame(t));

  function onFrame(now: number, m?: VideoFrameCallbackMetadata) {
    if (m) { camFrames += lastPresented < 0 ? 1 : m.presentedFrames - lastPresented; lastPresented = m.presentedFrames; }
    const w = video.videoWidth, h = video.videoHeight;
    if (w && h) {
      if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
      wctx.drawImage(video, 0, 0);
      const img = wctx.getImageData(0, 0, w, h), res = decodeFrame(img);
      if (res.status === 'sem-cabecalho') lastFail = img;
      else if (res.status === 'ok') lastOk = img;
      procFrames++;
      lastStatus = res.status;
      if (res.status === 'ok' || res.status === 'misturado') lastSeen = now;
      const inst = res.anchors ? perimeterRatio(res.anchors) : 0;
      if (res.anchors) scale = 0.8 * scale + 0.2 * inst;
      log.add(res, inst, camFps, procFps);
      count[res.status]++;
      if (res.status === 'ok' && res.header) {
        const test = res.header.type === TYPE_TEST; // no teste o fps muda de propósito a cada bloco
        if (header && (header.session !== res.header.session || (!test && header.fps !== res.header.fps))) resetStats();
        header = res.header;
        const f = res.header.frame;
        if (f < seenFrames[seenFrames.length - 1]) seenFrames = []; // PC reiniciou a contagem (novo Calibrar)
        if (seenFrames[seenFrames.length - 1] !== f) {
          seenFrames.push(f);
          while (seenFrames[0] <= f - USE_WINDOW) seenFrames.shift();
        }
        const s = stats[res.header.config];
        s.frames++; s.cells += res.cells!; s.errors += res.errors!;
      }
      overlay(res.anchors, w, res.status === 'ok');
    }
    if (now - t0 >= 1000) {
      camFps = (camFrames * 1000) / (now - t0); procFps = (procFrames * 1000) / (now - t0);
      camFrames = procFrames = 0; t0 = now;
    }
    if (now - lastUi > 250) { lastUi = now; ui(); }
    schedule();
  }

  function overlay(anchors: Pt[] | null, vw: number, ok: boolean) {
    const dpr = devicePixelRatio;
    ov.width = Math.round(ov.clientWidth * dpr); ov.height = Math.round(ov.clientHeight * dpr);
    const ctx = ov.getContext('2d')!, k = ov.width / vw;
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (!anchors) return;
    ctx.fillStyle = ok ? '#2ecc71' : '#f1c40f';
    for (const p of anchors) { ctx.beginPath(); ctx.arc(p.x * k, p.y * k, 8 * dpr, 0, 7); ctx.fill(); }
  }

  function ui() {
    const now = performance.now();
    const fps = header?.fps ?? 15, span = seenFrames.length ? Math.min(USE_WINDOW, seenFrames[seenFrames.length - 1] - seenFrames[0] + 1) : 0;
    // imagens distintas lidas ÷ imagens mostradas pelo PC (pelo índice no cabeçalho)
    const use = span ? seenFrames.length / span : 0;
    stat.textContent = `câmera ${video.videoWidth}×${video.videoHeight} · ${camFps.toFixed(0)} fps · processando ${procFps.toFixed(0)} fps · escala ${scale.toFixed(2)}× · aproveitamento ${seenFrames.length}/${span} imagens (${(100 * use).toFixed(0)}%)`
      + ` · ok ${count.ok} · misturados ${count.misturado} · sem cabeçalho ${count['sem-cabecalho']} · sem marcadores ${count['sem-marcadores']}`;
    meta.textContent = header
      ? `Arquivo: ${header.name} · ${header.size.toLocaleString('pt-BR')} bytes · SHA-256 ${hex(header.sha)}`
      : 'Aguardando cabeçalho…';

    let best = -1;
    const rows = CONFIGS.map((c, i) => {
      const s = stats[i], err = s.cells ? s.errors / s.cells : NaN, rate = kbps(c, fps);
      if (s.frames >= MIN_FRAMES && err <= MAX_ERR && (best < 0 || rate > kbps(CONFIGS[best], fps))) best = i;
      return `<tr><td>${i + 1}</td><td>${c.cell}px</td><td>${c.colors}</td><td>${s.frames}</td>`
        + `<td>${Number.isNaN(err) ? '–' : (100 * err).toFixed(2) + '%'}</td><td>${rate.toFixed(0)}</td></tr>`;
    });
    tbl.innerHTML = '<tr><th>Nível</th><th>Célula</th><th>Cores</th><th>Leituras</th><th>Erro</th><th>KB/s est.</th></tr>' + rows.join('');

    const done = header && stats.every((s) => s.frames >= MIN_FRAMES);
    const hint = lastStatus === 'sem-marcadores' || lastStatus === 'sem-cabecalho' ? '\nenquadre os 4 cantos'
      : scale < 0.8 ? `\nescala ${scale.toFixed(2)}×: aproxime` : `\nescala ${scale.toFixed(2)}× ✓`;
    if (header?.type === TYPE_TEST) {
      const c = CONFIGS[header.config];
      const lost = now - lastSeen > LOST_MS; // um quadro ruim isolado não muda a instrução
      const { progress, action } = log.coverage(lost ? 0 : scale);
      verdict.textContent = `${ACTION_TEXT[action]}\n${progress}% concluído`;
      verdict.className = 'verdict big' + (action === 'pronto' ? ' done' : '');
      return;
    }
    verdict.textContent = !done ? 'Calibrando…' + hint
      : best < 0 ? 'Calibrado: nenhum nível com erro aceitável. Aproxime, reduza o reflexo ou baixe as imagens/s no PC.'
      : `✅ Calibrado: use o nível ${best + 1} no PC\n~${kbps(CONFIGS[best], fps).toFixed(0)} KB/s teórico · ~${(kbps(CONFIGS[best], fps) * use).toFixed(0)} KB/s real`;
    verdict.className = 'verdict' + (!done ? '' : best < 0 ? ' warn' : ' done');
  }
}

/** px de câmera por px de quadro: perímetro dos marcadores na imagem / no quadro. */
function perimeterRatio(a: Pt[]) {
  const per = (p: Pt[]) => p.reduce((s, q, i) => s + Math.hypot(q.x - p[(i + 1) % 4].x, q.y - p[(i + 1) % 4].y), 0);
  return per(a) / per(ANCHOR_CENTERS);
}

/** Uma imagem só: texto do relatório no topo e os quadros da câmera em resolução cheia abaixo. */
async function buildReport(lines: string[], frames: [string, ImageData][]) {
  const W = Math.max(1000, ...frames.map(([, im]) => im.width)), LH = 24, cols = Math.floor((W - 20) / 11);
  const text = lines.flatMap((s) => s.match(new RegExp(`.{1,${cols}}`, 'g')) ?? ['']);
  const textH = (text.length + frames.length + 1) * LH + 10;
  let y = textH;
  const layout = frames.map(([label, im]) => {
    const at = y + LH;
    y = at + im.height;
    text.push(`recorte "${label}": x=0 y=${at} ${im.width}x${im.height}`);
    return { label, im, at };
  });
  const c = document.createElement('canvas');
  c.width = W; c.height = y;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, y);
  ctx.fillStyle = '#000'; ctx.font = '18px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'top';
  text.forEach((s, i) => ctx.fillText(s, 10, 6 + i * LH));
  for (const { label, im, at } of layout) {
    ctx.fillText(`▼ ${label}`, 10, at - LH + 3);
    ctx.putImageData(im, 0, at);
  }
  const blob = await new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('toBlob'))), 'image/png'));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return new File([blob], `qrfi-relatorio-${stamp}.png`, { type: 'image/png' });
}
