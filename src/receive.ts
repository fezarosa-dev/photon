// Tela do celular: filma, lê cada quadro e mede o erro por nível até declarar "Calibrado".
import { ANCHOR_CENTERS, CONFIGS, FLAG_DEFLATE, bitsOf, rawKbps, TYPE_DATA, TYPE_TEST, decodeFrame, hex, kbps, type Header, type Status } from './frame.ts';
import { inflate, makePlan, makeReceiver, pickRate, rxKey, type Words } from './transfer.ts';
import type { Done, Job } from './worker.ts';
import { BACK_CAM, segValue, segmented, wireBack } from './ui.ts';
import { createLog } from './log.ts';
import type { Pt } from './detect.ts';

const MIN_FRAMES = 5;   // leituras limpas por nível para considerar medido
const MAX_ERR = 0.05;   // ponytail: erro de símbolo tolerável estimado; recalibrar quando o LDPC existir
const SYNC_MS = 10_000; // envio automático das planilhas ao PC (só no servidor de desenvolvimento)
const ROT_STABLE = 6;   // quadros seguidos no mesmo ângulo antes de girar o painel
const LOST_MS = 600;    // só pede para enquadrar depois desse tempo sem ler nenhum quadro
const ACTION_TEXT = {
  pronto: '✅ Pode parar', enquadre: '🔲 Enquadre os 4 cantos', parado: '✋ Fique parado',
  aproxime: '⬆️ Aproxime', afaste: '⬇️ Afaste',
} as const;

/** auto: abre a câmera já (chamado de dentro do clique, que o Safari exige para a câmera). */
export function mountReceive(root: HTMLElement, auto = false) {
  document.body.classList.add('cam');
  const RING = 2 * Math.PI * 52;
  root.innerHTML = `
    <div class="view">
      <video id="v" playsinline muted></video><canvas id="ov"></canvas>
      ${BACK_CAM}
      <div class="center"><div class="stack" id="stack">
        <span class="pill glass" id="pill">Enquadre a tela do PC</span>
        <svg class="ring" id="ring" viewBox="0 0 120 120" style="display:none" aria-hidden="true">
          <circle class="track" cx="60" cy="60" r="52"/>
          <circle class="bar" id="ringbar" cx="60" cy="60" r="52" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/>
        </svg>
        <p id="verdict" class="verdict" role="status" aria-live="polite">Toque em Abrir câmera</p>
      </div></div>
      <div class="toolbar">
        <div class="group glass">${segmented('res', [['1920x1080', '1080p'], ['2560x1440', '1440p'], ['3840x2160', '4K']], '1920x1080')}</div>
        <button class="btn" id="go">Abrir câmera</button>
        <button class="btn success" id="save" hidden>Salvar</button>
      </div>
    </div>`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const pill = $('pill'), ring = $('ring'), ringbar = $('ringbar'), stack = $('stack');
  let rot = 0, rotCand = 0, rotHits = 0; // giro do painel: segue a tela do PC na imagem (celular deitado)
  const go = $<HTMLButtonElement>('go'), video = $<HTMLVideoElement>('v'), ov = $<HTMLCanvasElement>('ov');
  const verdict = $('verdict');
  let statText = '', metaText = ''; // só para a telemetria (planilhas no PC)
  wireBack(root);
  const log = createLog();
  const save = $<HTMLButtonElement>('save');

  // ---- recepção de arquivo (quadros de dados) ----
  type Rx = { key: string; h: Header; rx: ReturnType<typeof makeReceiver>; done: Set<number>; t0: number; result?: string };
  let rx: Rx | null = null;

  async function finish(r: Rx) {
    let bytes = r.rx.result();
    if (r.h.flags! & FLAG_DEFLATE) bytes = await inflate(bytes);
    const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
    const ok = hex(sha) === hex(r.h.sha);
    const secs = (performance.now() - r.t0) / 1000;
    r.result = ok ? `✅ Arquivo íntegro\n${(bytes.length / 1024 / secs).toFixed(0)} KB/s · ${secs.toFixed(0)} s` : '❌ SHA-256 não confere';
    if (!ok) return;
    const file = new File([bytes as BlobPart], r.h.name || 'arquivo', { type: 'application/octet-stream' });
    save.hidden = false;
    save.onclick = async () => { // só no aparelho: nada volta ao PC
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }).catch(() => {}); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = file.name; a.click();
    };
  }

  function onData(h: Header, words: Words | undefined): string {
    if (!rx || rx.key !== rxKey(h)) {
      rx = { key: rxKey(h), h, rx: makeReceiver(h.plen!, makePlan(h.config, h.rate!)), done: new Set(), t0: performance.now() };
      save.hidden = true;
    }
    if (!words || rx.rx.done) return '';
    const r = rx, ok = r.rx.addWords(words);
    if (ok === words.m) r.done.add(h.frame); // todas as palavras certas: não precisa ler essa imagem de novo
    if (r.rx.done) finish(r);
    return `${ok}/${words.m}`;
  }
  let synced = -1;

  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true })!;
  let stats = CONFIGS.map(() => ({ frames: 0, cells: 0, errors: 0 }));
  const count: Record<Status, number> = { 'sem-marcadores': 0, 'sem-cabecalho': 0, misturado: 0, ok: 0 };
  let header: Header | null = null;
  let scale = 0, lastStatus: Status = 'sem-marcadores', lastSeen = -Infinity; // lastSeen: último quadro lido (ms)
  const USE_WINDOW = 150;        // janela (em imagens do emissor) para medir o aproveitamento
  let seen = new Set<number>(), seenMax = -1; // índices distintos lidos com sucesso, dentro da janela (chegam fora de ordem)
  let camFrames = 0, procFrames = 0, camFps = 0, procFps = 0, lastPresented = -1, t0 = 0, lastUi = 0;

  const resetStats = () => {
    stats = CONFIGS.map(() => ({ frames: 0, cells: 0, errors: 0 }));
    for (const k in count) count[k as Status] = 0;
    seen = new Set(); seenMax = -1;
  };

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      verdict.textContent = 'Câmera indisponível: abra a página por https://';
      return;
    }
    (video.srcObject as MediaStream | null)?.getTracks().forEach((tr) => tr.stop());
    const [w, h] = segValue(root, 'res').split('x').map(Number);
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
  root.querySelector('input[name="res"]')!.closest('.seg')!.addEventListener('change', () => { if (go.hidden) start(); });

  /** Telemetria de desenvolvimento: grava as planilhas no PC (só existe no servidor de dev; em produção falha em silêncio). */
  async function upload(files: File[]) {
    for (const f of files) {
      const r = await fetch(`/__relatorio?nome=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }
  }
  setInterval(() => {
    if (!go.hidden || log.count === synced) return;
    synced = log.count;
    upload(log.files(reportLines().slice(0, 9))).catch(() => { /* sem servidor de dev */ });
  }, SYNC_MS);

  function reportLines() {
    const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    const fps = header?.fps ?? 15;
    return [
      `qrFI relatório · ${new Date().toISOString()}`,
      `ua: ${navigator.userAgent}`,
      `tela ${screen.width}x${screen.height} dpr ${devicePixelRatio}`,
      statText,
      metaText,
      `veredito: ${verdict.textContent}`,
      `sessão ${header ? header.session.toString(16) : '-'} · imagens/s do emissor ${fps} · resolução pedida ${segValue(root, 'res')}`,
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

  // ---- pool de workers: a thread principal só captura e distribui; ler + LDPC rodam em paralelo ----
  const POOL = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
  const useBitmap = typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
  const pool = Array.from({ length: POOL }, () => {
    const slot = { w: new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }), busy: false };
    slot.w.onmessage = (e: MessageEvent<Done>) => { slot.busy = false; onResult(e.data); };
    slot.w.onerror = (e) => { slot.busy = false; console.error('worker', e.message); };
    return slot;
  });
  let seq = 0, dropped = 0, workMs = 0;

  function dispatch() {
    const slot = pool.find((s) => !s.busy), w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    if (!slot) { dropped++; return; } // todos ocupados: descarta (sem fila, latência baixa)
    slot.busy = true;
    const job: Job = { seq: seq++, key: rx?.key ?? '', skip: rx ? [...rx.done].slice(-512) : [], skipAll: !!rx?.rx.done };
    if (useBitmap) {
      createImageBitmap(video).then((bitmap) => slot.w.postMessage({ ...job, bitmap }, [bitmap])).catch(() => { slot.busy = false; });
    } else {
      if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
      wctx.drawImage(video, 0, 0);
      const img = wctx.getImageData(0, 0, w, h);
      slot.w.postMessage({ ...job, pixels: { data: img.data, width: w, height: h } }, [img.data.buffer]);
    }
  }

  function onResult({ res, words, ms }: Done) {
    const now = performance.now();
    procFrames++;
    workMs = workMs ? 0.9 * workMs + 0.1 * ms : ms;
    const ldpc = res.status === 'ok' && res.header?.type === TYPE_DATA ? onData(res.header, words) : '';
    lastStatus = res.status;
    if (res.status === 'ok' || res.status === 'misturado') lastSeen = now;
    if (res.status === 'ok' && res.anchors) follow(res.anchors);
    const inst = res.anchors ? perimeterRatio(res.anchors) : 0;
    if (res.anchors) scale = 0.8 * scale + 0.2 * inst;
    log.add(res, inst, camFps, procFps, ldpc);
    count[res.status]++;
    if (res.status === 'ok' && res.header) {
      const test = res.header.type === TYPE_TEST; // no teste o fps muda de propósito a cada bloco
      if (header && (header.session !== res.header.session || (!test && header.fps !== res.header.fps))) resetStats();
      header = res.header;
      const f = res.header.frame;
      if (f < seenMax - 2 * USE_WINDOW) { seen = new Set(); seenMax = -1; } // PC reiniciou a contagem (novo Calibrar)
      seen.add(f);
      if (f > seenMax) { seenMax = f; for (const x of seen) if (x <= f - USE_WINDOW) seen.delete(x); }
      const s = stats[res.header.config];
      if (res.errors !== undefined) { s.frames++; s.cells += res.cells!; s.errors += res.errors; } // dados não têm erro medido
    }
    overlay(res.anchors, video.videoWidth, video.videoHeight, res.status === 'ok');
  }

  /**
   * Gira o painel para o ângulo (múltiplo de 90°) em que a tela do PC aparece na imagem: assim o texto fica
   * em pé para quem segura o celular deitado, mesmo com a rotação do iPhone travada. Sem sensor nem permissão.
   */
  function follow(a: Pt[]) {
    const deg = (Math.round((Math.atan2(a[1].y - a[0].y, a[1].x - a[0].x) * 180) / Math.PI / 90) * 90 + 360) % 360;
    if (deg !== rotCand) { rotCand = deg; rotHits = 0; }
    if (++rotHits < ROT_STABLE || deg === ((rot % 360) + 360) % 360) return;
    let delta = deg - (((rot % 360) + 360) % 360);
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    rot += delta; // caminho mais curto (270° → −90°)
    stack.style.transform = `rotate(${rot}deg)`;
  }

  function onFrame(now: number, m?: VideoFrameCallbackMetadata) {
    if (m) { camFrames += lastPresented < 0 ? 1 : m.presentedFrames - lastPresented; lastPresented = m.presentedFrames; }
    dispatch();
    if (now - t0 >= 1000) {
      camFps = (camFrames * 1000) / (now - t0); procFps = (procFrames * 1000) / (now - t0);
      camFrames = procFrames = 0; t0 = now;
    }
    if (now - lastUi > 250) { lastUi = now; ui(); }
    schedule();
  }

  function overlay(anchors: Pt[] | null, vw: number, vh: number, ok: boolean) {
    const dpr = devicePixelRatio;
    ov.width = Math.round(ov.clientWidth * dpr); ov.height = Math.round(ov.clientHeight * dpr);
    const ctx = ov.getContext('2d')!;
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (!anchors || !vw || !vh) return;
    // o vídeo usa object-fit: contain → mesma escala nos dois eixos, centralizado
    const k = Math.min(ov.width / vw, ov.height / vh), ox = (ov.width - vw * k) / 2, oy = (ov.height - vh * k) / 2;
    ctx.fillStyle = ok ? '#30d158' : '#ffd60a';
    for (const p of anchors) { ctx.beginPath(); ctx.arc(ox + p.x * k, oy + p.y * k, 9 * dpr, 0, 7); ctx.fill(); }
  }

  function ui() {
    const now = performance.now();
    if (go.hidden) pill.textContent = `${camFps.toFixed(0)} fps · escala ${scale.toFixed(2)}× · ${procFps.toFixed(0)} lidas/s`;
    ring.style.display = rx && header?.type === TYPE_DATA ? 'block' : 'none'; // SVG não tem a propriedade hidden
    if (rx) ringbar.setAttribute('stroke-dashoffset', String(RING * (1 - rx.rx.progress)));
    const fps = header?.fps ?? 15, span = seen.size ? Math.min(USE_WINDOW, seenMax - Math.min(...seen) + 1) : 0;
    // imagens distintas lidas ÷ imagens mostradas pelo PC (pelo índice no cabeçalho)
    const use = span ? Math.min(1, seen.size / span) : 0;
    statText = `câmera ${video.videoWidth}×${video.videoHeight} · ${camFps.toFixed(0)} fps · processando ${procFps.toFixed(0)} fps · escala ${scale.toFixed(2)}× · aproveitamento ${seen.size}/${span} imagens (${(100 * use).toFixed(0)}%) · ${POOL} workers, ${workMs.toFixed(0)} ms/quadro, ${dropped} descartados`
      + ` · ok ${count.ok} · misturados ${count.misturado} · sem cabeçalho ${count['sem-cabecalho']} · sem marcadores ${count['sem-marcadores']}`;
    metaText = header
      ? `Arquivo: ${header.name} · ${header.size.toLocaleString('pt-BR')} bytes · SHA-256 ${hex(header.sha)}`
      : 'Aguardando cabeçalho…';

    let best = -1, bestNet = 0;
    const FOUNTAIN = 0.93; // ~7% de pacotes a mais no fountain (medido)
    CONFIGS.forEach((c, i) => { // melhor nível = maior vazão líquida com a paridade que o erro medido exige
      const s = stats[i], R = s.frames >= MIN_FRAMES ? pickRate(s.errors / s.cells, bitsOf(c)) : 0;
      const net = rawKbps(c, fps) * R * FOUNTAIN * (use || 1);
      if (R && net > bestNet) { best = i; bestNet = net; }
    });

    const done = header && stats.every((s) => s.frames >= MIN_FRAMES);
    const hint = lastStatus === 'sem-marcadores' || lastStatus === 'sem-cabecalho' ? '\nenquadre os 4 cantos'
      : scale < 0.8 ? `\nescala ${scale.toFixed(2)}×: aproxime` : `\nescala ${scale.toFixed(2)}× ✓`;
    if (rx && header?.type === TYPE_DATA) {
      const r = rx, s = r.rx.stats, secs = (now - r.t0) / 1000, p = r.rx.progress;
      const rate = r.rx.usefulBytes / 1024 / Math.max(secs, 0.1), left = p > 0 ? (secs * (1 - p)) / p : Infinity;
      verdict.textContent = r.result ?? `${(100 * r.rx.progress).toFixed(0)}%\n${rate.toFixed(0)} KB/s · faltam ${Number.isFinite(left) ? Math.ceil(left) + ' s' : '…'}`;
      verdict.className = 'verdict big' + (r.result?.startsWith('✅') ? ' done' : r.result ? ' warn' : '');
      metaText = `Recebendo ${r.h.name} · ${r.h.size.toLocaleString('pt-BR')} bytes · palavras ok ${s.wordsOk}/${s.words} · CRC falhou ${s.crcFail} · pacotes ${s.received}/${r.rx.k} · recuperados ${s.recovered}`;
      return;
    }
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
      : `✅ No PC: nível ${best + 1} · paridade ${Math.round((1 - pickRate(stats[best].errors / stats[best].cells, bitsOf(CONFIGS[best]))) * 100)}%\n~${bestNet.toFixed(0)} KB/s líquidos`;
    verdict.className = 'verdict' + (!done ? '' : best < 0 ? ' warn' : ' done');
  }
}

/** px de câmera por px de quadro: perímetro dos marcadores na imagem / no quadro. */
function perimeterRatio(a: Pt[]) {
  const per = (p: Pt[]) => p.reduce((s, q, i) => s + Math.hypot(q.x - p[(i + 1) % 4].x, q.y - p[(i + 1) % 4].y), 0);
  return per(a) / per(ANCHOR_CENTERS);
}
