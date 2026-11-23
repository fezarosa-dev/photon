// Código fonte LT sistemático (fountain). Pacotes ids 0..k-1 = fonte; ids>=k = reparo LT.
// Decodificação: peeling + eliminação gaussiana GF(2) quando trava.
import { rng } from './frame.ts';

const C = 0.02;      // parâmetros da distribuição soliton robusta
const DELTA = 0.05;
const MAX_CORE = 2000; // só elimina se o núcleo pós-peeling for pequeno (custo ~u³)

const cdfCache = new Map<number, Float64Array>();
// CDF acumulada dos graus 1..k (índice = grau)
function cdf(k: number): Float64Array {
  let t = cdfCache.get(k);
  if (t) return t;
  const R = C * Math.log(k / DELTA) * Math.sqrt(k);
  const M = Math.max(1, Math.min(k, Math.round(k / R)));
  t = new Float64Array(k + 1);
  let sum = 0;
  for (let i = 1; i <= k; i++) {
    let p = i === 1 ? 1 / k : 1 / (i * (i - 1));
    if (i < M) p += R / (i * k);
    else if (i === M) p += Math.max(0, (R * Math.log(R / DELTA)) / k);
    t[i] = sum += p;
  }
  for (let i = 1; i <= k; i++) t[i] /= sum;
  cdfCache.set(k, t);
  return t;
}

// Hash (k,id) -> semente (finalizador estilo murmur3)
function seed(k: number, id: number): number {
  let h = Math.imul(k ^ 0x9e3779b9, 0x85ebca6b) ^ id;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

let stamp = new Uint32Array(0);
let gen = 0;
// Vizinhos (índices fonte distintos) do pacote de reparo `id`
function neighbors(k: number, id: number): number[] {
  const r = rng(seed(k, id));
  const t = cdf(k);
  const u = r() / 4294967296;
  let lo = 1, hi = k;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] > u) hi = m; else lo = m + 1; }
  if (stamp.length < k) { stamp = new Uint32Array(k); gen = 0; }
  gen++;
  const out: number[] = [];
  while (out.length < lo) {
    const n = Math.floor((r() / 4294967296) * k);
    if (stamp[n] !== gen) { stamp[n] = gen; out.push(n); }
  }
  return out;
}

export function ltEncoder(data: Uint8Array, packetSize: number): { k: number; packet(id: number): Uint8Array } {
  const k = Math.max(1, Math.ceil(data.length / packetSize));
  const src = new Uint8Array(k * packetSize);
  src.set(data);
  return {
    k,
    packet(id: number): Uint8Array {
      const out = new Uint8Array(packetSize);
      if (id < k) { out.set(src.subarray(id * packetSize, (id + 1) * packetSize)); return out; }
      for (const n of neighbors(k, id)) {
        const o = n * packetSize;
        for (let j = 0; j < packetSize; j++) out[j] ^= src[o + j];
      }
      return out;
    },
  };
}

interface Eq { id: number; buf: Uint32Array; deg: number; sum: number }

export function ltDecoder(k: number, packetSize: number): {
  add(id: number, payload: Uint8Array): boolean;
  readonly done: boolean;
  readonly received: number;
  readonly recovered: number;
  result(): Uint8Array;
} {
  const W = Math.ceil(packetSize / 4);          // palavras de 32 bits por pacote
  const src = new Uint32Array(k * W);
  const known = new Uint8Array(k);
  const seen = new Set<number>();
  const adj: (Eq[] | undefined)[] = new Array(k);
  const alive = new Set<Eq>();
  const queue: number[] = [];
  let recovered = 0, done = false, nextTry = k, deficit = 0;

  const xorSrc = (buf: Uint32Array, n: number) => {
    for (let j = 0, o = n * W; j < W; j++) buf[j] ^= src[o + j];
  };
  const setSrc = (n: number, buf: Uint32Array) => {
    src.set(buf, n * W); known[n] = 1; recovered++; queue.push(n);
  };
  // propaga fontes recém-conhecidas (peeling)
  const peel = () => {
    while (queue.length) {
      const s = queue.pop()!;
      const l = adj[s];
      adj[s] = undefined;
      if (!l) continue;
      for (const e of l) {
        if (!alive.has(e)) continue;
        xorSrc(e.buf, s); e.deg--; e.sum -= s;
        if (e.deg === 1) {
          alive.delete(e);
          if (!known[e.sum]) setSrc(e.sum, e.buf);
        } else if (e.deg === 0) alive.delete(e);
      }
    }
  };

  // Eliminação gaussiana nas incógnitas restantes; true se resolveu tudo
  const solve = (): boolean => {
    const cols: number[] = [], colOf = new Int32Array(k).fill(-1);
    for (let i = 0; i < k; i++) if (!known[i]) { colOf[i] = cols.length; cols.push(i); }
    const u = cols.length, Wb = (u + 31) >>> 5;
    const eqs = [...alive], n = eqs.length;
    const mat = new Uint32Array(n * Wb);
    eqs.forEach((e, r) => {
      for (const x of neighbors(k, e.id)) if (colOf[x] >= 0) mat[r * Wb + (colOf[x] >> 5)] ^= 1 << (colOf[x] & 31);
    });
    // Retorna ordem das linhas (posto cheio) ou o déficit de posto (número)
    const run = (m: Uint32Array, full: boolean): Int32Array | number => {
      const ord = new Int32Array(n).map((_, i) => i);
      let r = 0;
      for (let c = 0; c < u; c++) {
        const w = c >> 5, b = 1 << (c & 31);
        let p = r;
        while (p < n && !(m[ord[p] * Wb + w] & b)) p++;
        if (p === n) continue;                       // coluna sem pivô
        [ord[r], ord[p]] = [ord[p], ord[r]];
        const pr = ord[r] * Wb;
        for (let i = full ? 0 : r + 1; i < n; i++) {
          const ri = ord[i];
          if (i === r || !(m[ri * Wb + w] & b)) continue;
          for (let j = w; j < Wb; j++) m[ri * Wb + j] ^= m[pr + j];
          if (full) { const a = eqs[ri].buf, s = eqs[ord[r]].buf; for (let j = 0; j < W; j++) a[j] ^= s[j]; }
        }
        r++;
      }
      return r === u ? ord : u - r;
    };
    const rk = run(mat.slice(), false);              // 1ª passada: só posto (sem payload)
    if (typeof rk === 'number') { deficit = rk; return false; }
    const ord = run(mat, true) as Int32Array;
    for (let c = 0; c < u; c++) {
      src.set(eqs[ord[c]].buf, cols[c] * W); known[cols[c]] = 1; recovered++;
    }
    return true;
  };

  const self = {
    add(id: number, payload: Uint8Array): boolean {
      if (done || payload.length !== packetSize || seen.has(id)) return done;
      seen.add(id);
      const buf = new Uint32Array(W);
      new Uint8Array(buf.buffer).set(payload);
      if (id < k) { if (!known[id]) { setSrc(id, buf); peel(); } }
      else {
        const e: Eq = { id, buf, deg: 0, sum: 0 };
        const unk: number[] = [];
        for (const x of neighbors(k, id)) {
          if (known[x]) xorSrc(buf, x); else { unk.push(x); e.sum += x; }
        }
        e.deg = unk.length;
        if (e.deg === 1) { setSrc(e.sum, buf); peel(); }
        else if (e.deg > 1) {
          alive.add(e);
          for (const x of unk) (adj[x] ??= []).push(e);
        }
      }
      if (recovered < k && seen.size >= nextTry && alive.size >= k - recovered && k - recovered <= MAX_CORE) {
        if (solve()) peel(); else nextTry = seen.size + Math.max(1, deficit); // faltam >= déficit linhas
      }
      if (recovered === k) done = true;
      return done;
    },
    get done() { return done; },
    get received() { return seen.size; },
    get recovered() { return recovered; },
    result(): Uint8Array {
      const out = new Uint8Array(k * packetSize);
      const b = new Uint8Array(src.buffer);
      for (let i = 0; i < k; i++) out.set(b.subarray(i * W * 4, i * W * 4 + packetSize), i * packetSize);
      return out;
    },
  };
  return self;
}
