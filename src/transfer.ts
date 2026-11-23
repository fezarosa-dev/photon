// Transferência: arquivo → pacotes fountain → palavras LDPC (com id + CRC) → bits espalhados no quadro → cores.
// O receptor faz o caminho inverso a partir dos bits suaves (LLR) de cada quadro.
import { CONFIGS, bitsOf, crc32, grid, rng, type Config, type Header } from './frame.ts';
import { makeLdpc, type Ldpc } from './ldpc.ts';
import { ltDecoder, ltEncoder } from './fountain.ts';

export const RATES = [0.5, 0.67, 0.75, 0.83, 0.9]; // taxas do LDPC oferecidas (k/n)
// erro de bit (canal binário) que cada taxa corrige em ≥95% das palavras (n≈12000, medido em test/ldpc.test.ts)
const LIMIT: Record<number, number> = { 0.5: 0.0746, 0.67: 0.0423, 0.75: 0.0284, 0.83: 0.0158, 0.9: 0.0068 };
const MARGIN = 0.7; // folga: a mão mexe e o erro varia entre quadros

/** Maior taxa que aguenta o erro de símbolo medido (cores em Gray: símbolo errado ≈ 1 bit errado), ou 0. */
export function pickRate(symbolErr: number, bits: number) {
  const pb = symbolErr / bits;
  return RATES.filter((r) => LIMIT[r] * MARGIN >= pb).pop() ?? 0;
}
const CW_MAX = 16000; // bits por palavra-código (alvo): blocos grandes corrigem melhor
const PKT_OVERHEAD = 8; // id (4) + CRC32 (4) dentro de cada palavra-código
const FOUNTAIN_NEED = 1.08; // pacotes necessários ÷ k (medido: 1,06–1,15)

export interface Plan {
  cfg: Config; rate: number;
  slots: number;     // bits disponíveis no quadro (células × bits/célula)
  m: number;         // palavras-código por quadro
  n: number; k: number; // bits por palavra-código / bits de informação (múltiplo de 8)
  packetSize: number;   // bytes de conteúdo por palavra-código
  perm: Uint32Array;    // bit t da palavra j → posição perm[j*n + t] no quadro (entrelaçamento)
  ldpc: Ldpc;
}

const plans = new Map<string, Plan>();

/** Plano determinístico por (nível, taxa): emissor e receptor montam o mesmo. Cacheado (montar o LDPC custa). */
export function makePlan(config: number, rate: number): Plan {
  const key = `${config}|${rate}`;
  const cached = plans.get(key);
  if (cached) return cached;
  const cfg = CONFIGS[config], g = grid(cfg), slots = g.cols * g.rows * bitsOf(cfg);
  const m = Math.ceil(slots / CW_MAX), n = Math.floor(slots / m), k = Math.floor((n * rate) / 8) * 8;
  // entrelaçamento: permutação pseudoaleatória das posições, para um borrão local espalhar erros por várias palavras
  const perm = Uint32Array.from({ length: slots }, (_, i) => i), r = rng(0x51460002 ^ (config << 8) ^ k);
  for (let i = slots - 1; i > 0; i--) { const j = r() % (i + 1); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  const plan = { cfg, rate, slots, m, n, k, packetSize: k / 8 - PKT_OVERHEAD, perm, ldpc: makeLdpc(n, k, 0x51460000 ^ config) };
  plans.set(key, plan);
  return plan;
}

const toBits = (bytes: Uint8Array, out: Uint8Array) => {
  for (let i = 0; i < out.length; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
};
const toBytes = (bits: Uint8Array, out: Uint8Array) => {
  out.fill(0);
  for (let i = 0; i < bits.length; i++) out[i >> 3] |= bits[i] << (7 - (i & 7));
};

/** Emissor: monta os símbolos (cores) do quadro `frame` a partir do conteúdo. */
export function makeSender(payload: Uint8Array, plan: Plan) {
  const enc = ltEncoder(payload, plan.packetSize), info = new Uint8Array(plan.k / 8), infoBits = new Uint8Array(plan.k);
  const bits = new Uint8Array(plan.slots), b = bitsOf(plan.cfg), cells = plan.slots / b, dv = new DataView(info.buffer);
  return {
    k: enc.k,
    symbols(frame: number) {
      bits.fill(0);
      for (let j = 0; j < plan.m; j++) {
        // só pacotes de reparo (id ≥ k): com perdas, o modo sistemático exige ~37% a mais de pacotes; reparo puro ~5%
        const id = (enc.k + frame * plan.m + j) >>> 0;
        dv.setUint32(0, id);
        info.set(enc.packet(id), 4);
        dv.setUint32(info.length - 4, crc32(info.subarray(0, info.length - 4)));
        toBits(info, infoBits);
        const cw = plan.ldpc.encode(infoBits);
        for (let t = 0; t < plan.n; t++) bits[plan.perm[j * plan.n + t]] = cw[t];
      }
      const syms = new Uint8Array(cells);
      for (let c = 0; c < cells; c++) {
        let s = 0;
        for (let t = 0; t < b; t++) s = (s << 1) | bits[c * b + t];
        syms[c] = s;
      }
      return syms;
    },
  };
}

/** Identifica uma recepção: mudar sessão, nível, taxa ou tamanho = outra transferência. */
export const rxKey = (h: Header) => `${h.session}|${h.config}|${h.rate}|${h.plen}`;

export interface Words { m: number; ok: number; crcFail: number; ids: number[]; payloads: Uint8Array[] }

/** Sem estado (roda no worker): corrige as palavras LDPC de um quadro e devolve os pacotes com CRC válido. */
export function decodeWords(plan: Plan, frameLlr: Float32Array): Words {
  const llr = new Float32Array(plan.n), info = new Uint8Array(plan.k / 8), dv = new DataView(info.buffer);
  const out: Words = { m: plan.m, ok: 0, crcFail: 0, ids: [], payloads: [] };
  for (let j = 0; j < plan.m; j++) {
    for (let t = 0; t < plan.n; t++) llr[t] = frameLlr[plan.perm[j * plan.n + t]];
    const res = plan.ldpc.decode(llr);
    if (!res.ok) continue;
    toBytes(res.bits, info);
    if (dv.getUint32(info.length - 4) !== crc32(info.subarray(0, info.length - 4))) { out.crcFail++; continue; }
    out.ids.push(dv.getUint32(0));
    out.payloads.push(info.slice(4, info.length - 4));
    out.ok++;
  }
  return out;
}

/** Receptor (com estado, fica na thread principal): junta os pacotes no fountain até completar. */
export function makeReceiver(plen: number, plan: Plan) {
  const k = Math.max(1, Math.ceil(plen / plan.packetSize)), dec = ltDecoder(k, plan.packetSize);
  let words = 0, wordsOk = 0, crcFail = 0;
  const addWords = (w: Words) => {
    words += w.m; wordsOk += w.ok; crcFail += w.crcFail;
    for (let i = 0; i < w.ids.length && !dec.done; i++) dec.add(w.ids[i], w.payloads[i]);
    return w.ok;
  };
  return {
    k,
    addWords,
    /** Atalho (testes / thread única): corrige e junta um quadro. */
    add: (frameLlr: Float32Array) => addWords(decodeWords(plan, frameLlr)),
    get done() { return dec.done; },
    // o fountain reconstrói quase tudo de uma vez no fim; progresso = pacotes bons recebidos ÷ ~necessários
    get progress() { return dec.done ? 1 : Math.min(0.99, dec.received / (k * FOUNTAIN_NEED)); },
    get usefulBytes() { return Math.min(dec.received, k) * plan.packetSize; },
    get stats() { return { words, wordsOk, crcFail, received: dec.received, recovered: dec.recovered }; },
    result() { return dec.result().slice(0, plen); },
  };
}

/** Comprime com deflate (nativo do navegador) só se ficar ao menos 5% menor. */
export async function maybeDeflate(data: Uint8Array): Promise<{ bytes: Uint8Array; deflated: boolean }> {
  const out = new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  return out.length < data.length * 0.95 ? { bytes: out, deflated: true } : { bytes: data, deflated: false };
}

export async function inflate(data: Uint8Array) {
  return new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
}
