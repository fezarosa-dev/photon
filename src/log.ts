// Registro das leituras no celular → planilhas CSV (resumo agregado + leituras brutas).
import { CONFIGS, TEST_FPS, kbps, type Decoded } from './frame.ts';

const MAX_RAW = 200_000; // ~15 MB de CSV; suficiente para >1 h a 50 leituras/s
const GAP = 60;          // salto de índice que encerra um bloco (celular perdeu a tela)
const MIN_READS = 5;     // leituras por combinação (fps × nível) em cada distância
const TARGETS = [0.5, 0.6, 0.7, 0.8]; // distâncias (escala) que a varredura precisa cobrir
export type Action = 'pronto' | 'enquadre' | 'parado' | 'aproxime' | 'afaste';

interface Row {
  fps: number; config: number; scale: number;
  reads: number; errors: number; cells: number; mixed: number; distinct: number; shown: number; cam: number; proc: number;
}
interface Block { fps: number; config: number; frames: Set<number>; min: number; max: number; scaleSum: number; n: number }

const bucket = (s: number) => Math.round(s * 10) / 10;
const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((v) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';

export function createLog() {
  const t0 = performance.now();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); // nome fixo: cada envio sobrescreve
  const raw: (string | number)[][] = [];
  const agg = new Map<string, Row>();
  let blk: Block | null = null;

  const row = (fps: number, config: number, scale: number) => {
    const k = `${fps}|${config}|${scale}`;
    let r = agg.get(k);
    if (!r) agg.set(k, (r = { fps, config, scale, reads: 0, errors: 0, cells: 0, mixed: 0, distinct: 0, shown: 0, cam: 0, proc: 0 }));
    return r;
  };

  // aproveitamento: imagens distintas lidas ÷ imagens mostradas, medido por bloco contínuo de mesmo (fps, nível)
  const closeBlock = () => {
    if (!blk) return;
    const r = row(blk.fps, blk.config, bucket(blk.scaleSum / blk.n));
    r.distinct += blk.frames.size;
    r.shown += blk.max - blk.min + 1;
    blk = null;
  };

  function add(res: Decoded, scale: number, cam: number, proc: number, ldpc = '') {
    const h = res.header;
    if (raw.length < MAX_RAW) {
      raw.push([Math.round(performance.now() - t0), res.status, h?.frame ?? '', h?.fps ?? '', h ? h.config + 1 : '',
        res.anchors ? scale.toFixed(3) : '', res.errors ?? '', res.cells ?? '', cam.toFixed(0), proc.toFixed(0), ldpc]);
    }
    if (!h || (res.status !== 'ok' && res.status !== 'misturado') || (res.status === 'ok' && res.errors === undefined)) return; // dados: só no bruto
    const r = row(h.fps, h.config, bucket(scale));
    if (res.status === 'misturado') { r.mixed++; return; }
    r.reads++; r.errors += res.errors!; r.cells += res.cells!; r.cam += cam; r.proc += proc;

    const f = h.frame;
    if (!blk || blk.fps !== h.fps || blk.config !== h.config || f < blk.max || f - blk.max > GAP) {
      closeBlock();
      blk = { fps: h.fps, config: h.config, frames: new Set(), min: f, max: f, scaleSum: 0, n: 0 };
    }
    blk.frames.add(f); blk.max = f; blk.scaleSum += scale; blk.n++;
  }

  function files(meta: string[]) {
    // cópia do agregado + bloco em andamento, sem fechá-lo (envio periódico não pode distorcer o aproveitamento)
    const snap = new Map([...agg].map(([k, r]) => [k, { ...r }]));
    if (blk) {
      const k = `${blk.fps}|${blk.config}|${bucket(blk.scaleSum / blk.n)}`;
      const r = snap.get(k) ?? { fps: blk.fps, config: blk.config, scale: bucket(blk.scaleSum / blk.n), reads: 0, errors: 0, cells: 0, mixed: 0, distinct: 0, shown: 0, cam: 0, proc: 0 };
      r.distinct += blk.frames.size; r.shown += blk.max - blk.min + 1;
      snap.set(k, r);
    }
    const rows = [...snap.values()].sort((a, b) => a.fps - b.fps || a.config - b.config || a.scale - b.scale);
    const summary = [
      ['fps_emissor', 'nivel', 'celula_px', 'cores', 'escala', 'leituras', 'erro_pct', 'misturados', 'distintas', 'mostradas',
        'aproveitamento_pct', 'kbps_teorico', 'kbps_real', 'cam_fps', 'proc_fps'],
      ...rows.map((r) => {
        const c = CONFIGS[r.config], use = r.shown ? r.distinct / r.shown : NaN, th = kbps(c, r.fps);
        return [r.fps, r.config + 1, c.cell, c.colors, r.scale.toFixed(1), r.reads,
          r.cells ? ((100 * r.errors) / r.cells).toFixed(2) : '', r.mixed, r.distinct, r.shown,
          Number.isNaN(use) ? '' : (100 * use).toFixed(1), th.toFixed(0), Number.isNaN(use) ? '' : (th * use).toFixed(0),
          r.reads ? (r.cam / r.reads).toFixed(0) : '', r.reads ? (r.proc / r.reads).toFixed(0) : ''];
      }),
    ];
    const head = ['t_ms', 'status', 'quadro', 'fps_emissor', 'nivel', 'escala', 'erros', 'celulas', 'cam_fps', 'proc_fps', 'ldpc_ok'];
    const metaCsv = meta.map((m) => '# ' + m.replace(/\n/g, ' ')).join('\n') + '\n';
    return [
      new File([metaCsv + csv(summary)], `qrfi-resumo-${stamp}.csv`, { type: 'text/csv' }),
      new File([csv([head, ...raw])], `qrfi-leituras-${stamp}.csv`, { type: 'text/csv' }),
    ];
  }

  /**
   * Progresso da varredura (0–100%) e o que fazer agora, dada a escala atual (0 = sem tela na imagem).
   * Meta: em cada distância de TARGETS, toda combinação fps × nível com MIN_READS leituras.
   */
  function coverage(scaleNow: number) {
    const total = TEST_FPS.length * CONFIGS.length, done = new Map<number, number>(TARGETS.map((s) => [s, 0]));
    for (const r of agg.values()) if (done.has(r.scale) && r.reads >= MIN_READS) done.set(r.scale, done.get(r.scale)! + 1);
    const progress = Math.round((100 * [...done.values()].reduce((s, d) => s + Math.min(d, total), 0)) / (total * TARGETS.length));
    const todo = TARGETS.filter((s) => done.get(s)! < total);
    const here = bucket(scaleNow);
    const action: Action = !todo.length ? 'pronto' : !scaleNow ? 'enquadre' : todo.includes(here) ? 'parado'
      : todo.reduce((a, b) => (Math.abs(b - here) < Math.abs(a - here) ? b : a)) > here ? 'aproxime' : 'afaste';
    return { progress, action };
  }

  return { add, files, coverage, get count() { return raw.length; } };
}
