// LDPC sistemático IRA (paridade em escada, como DVB-S2/802.11n) com codificação O(n)
// e decodificador min-sum normalizado em camadas. Determinístico em (n, k, seed).
import { rng } from './frame.ts';

export interface Ldpc {
  n: number;
  k: number;
  encode(info: Uint8Array): Uint8Array;
  decode(llr: Float32Array, maxIter?: number): { bits: Uint8Array; ok: boolean; iters: number };
}

const SAT = 20; // saturação dos LLRs de entrada
const ALPHA = 0.8; // fator de normalização do min-sum

// Perfil de graus das colunas de informação: [fração, grau]
function profile(rate: number): [number, number][] {
  if (rate < 0.6) return [[0.2, 12], [0.1, 6], [0.7, 3]];
  return [[0.15, 10], [0.15, 5], [0.7, 3]];
}

export function makeLdpc(n: number, k: number, seed = 1): Ldpc {
  const m = n - k;
  const rand = rng((seed ^ Math.imul(n, 0x9e3779b1) ^ Math.imul(k, 0x85ebca6b)) >>> 0);
  const ri = (x: number) => rand() % x;

  // graus das colunas de informação
  const deg = new Uint8Array(k);
  let c0 = 0;
  const prof = profile(k / n);
  for (let p = 0; p < prof.length; p++) {
    const cnt = p === prof.length - 1 ? k - c0 : Math.round(prof[p][0] * k);
    for (let i = 0; i < cnt && c0 < k; i++) deg[c0++] = prof[p][1];
  }
  // embaralha graus (colunas de grau alto espalhadas)
  for (let i = k - 1; i > 0; i--) { const j = ri(i + 1); const t = deg[i]; deg[i] = deg[j]; deg[j] = t; }
  let E = 0;
  for (let i = 0; i < k; i++) E += deg[i];

  // slots de linha balanceados, embaralhados
  const slots = new Int32Array(E);
  for (let i = 0; i < E; i++) slots[i] = i % m;
  for (let i = E - 1; i > 0; i--) { const j = ri(i + 1); const t = slots[i]; slots[i] = slots[j]; slots[j] = t; }

  // colunas de info -> linhas (CSC) e linhas -> colunas de info (listas encadeadas) p/ checar ciclos 4
  const cptr = new Int32Array(k + 1);
  for (let i = 0; i < k; i++) cptr[i + 1] = cptr[i] + deg[i];
  const crow = new Int32Array(E);
  const rhead = new Int32Array(m).fill(-1);
  const rnext = new Int32Array(E);
  const rcol = new Int32Array(E); // coluna dona da aresta e
  const stamp = new Int32Array(k).fill(-1);
  for (let c = 0; c < k; c++) {
    const b = cptr[c], d = deg[c];
    for (let t = 0; t < d; t++) {
      let ok = false;
      for (let tries = 0; tries < 40 && !ok; tries++) {
        const j = b + t + ri(E - (b + t));
        const r = slots[j];
        ok = true;
        for (let u = 0; u < t && ok; u++) {
          const a = crow[b + u];
          if (a === r || a - r === 1 || r - a === 1) ok = false; // repetida ou vizinha (ciclo 4 c/ paridade)
        }
        for (let e = rhead[r]; e >= 0 && ok; e = rnext[e]) if (stamp[rcol[e]] === c) ok = false;
        if (ok || tries === 39) { const x = slots[b + t]; slots[b + t] = slots[j]; slots[j] = x; ok = true; }
      }
      const r = slots[b + t];
      crow[b + t] = r;
      // marca colunas já ligadas a r para detectar ciclos com as próximas linhas
      for (let e = rhead[r]; e >= 0; e = rnext[e]) stamp[rcol[e]] = c;
      rcol[b + t] = c; rnext[b + t] = rhead[r]; rhead[r] = b + t;
    }
    // stamps de colunas vizinhas valem só durante esta coluna: c é único, nada a limpar
  }

  // CSR por linha: colunas de info + paridade (k+r-1, k+r)
  const rptr = new Int32Array(m + 1);
  for (let r = 0; r < m; r++) {
    let d = r > 0 ? 2 : 1;
    for (let e = rhead[r]; e >= 0; e = rnext[e]) d++;
    rptr[r + 1] = rptr[r] + d;
  }
  const E2 = rptr[m];
  const ridx = new Int32Array(E2);
  let maxDeg = 0;
  for (let r = 0; r < m; r++) {
    let p = rptr[r];
    for (let e = rhead[r]; e >= 0; e = rnext[e]) ridx[p++] = rcol[e];
    if (r > 0) ridx[p++] = k + r - 1;
    ridx[p++] = k + r;
    maxDeg = Math.max(maxDeg, p - rptr[r]);
  }

  const L = new Float32Array(n);
  const c2v = new Float32Array(E2);
  const q = new Float32Array(maxDeg);

  function encode(info: Uint8Array): Uint8Array {
    const out = new Uint8Array(n);
    out.set(info.subarray(0, k));
    for (let c = 0; c < k; c++) if (info[c]) for (let e = cptr[c]; e < cptr[c + 1]; e++) out[k + crow[e]] ^= 1;
    for (let r = 1; r < m; r++) out[k + r] ^= out[k + r - 1];
    return out;
  }

  function syndromeOk(): boolean {
    for (let r = 0; r < m; r++) {
      let s = 0;
      for (let e = rptr[r]; e < rptr[r + 1]; e++) s ^= L[ridx[e]] < 0 ? 1 : 0;
      if (s) return false;
    }
    return true;
  }

  function decode(llr: Float32Array, maxIter = 30) {
    for (let i = 0; i < n; i++) { const x = llr[i]; L[i] = x > SAT ? SAT : x < -SAT ? -SAT : x; }
    c2v.fill(0);
    let iters = 0;
    let ok = syndromeOk();
    while (!ok && iters < maxIter) {
      iters++;
      for (let r = 0; r < m; r++) {
        const s = rptr[r], f = rptr[r + 1];
        let m1 = 1e30, m2 = 1e30, sg = 0, imin = -1;
        for (let e = s; e < f; e++) {
          const v = L[ridx[e]] - c2v[e];
          q[e - s] = v;
          const a = v < 0 ? -v : v;
          if (v < 0) sg ^= 1;
          if (a < m1) { m2 = m1; m1 = a; imin = e; } else if (a < m2) m2 = a;
        }
        for (let e = s; e < f; e++) {
          const v = q[e - s];
          const mag = (e === imin ? m2 : m1) * ALPHA;
          const neg = sg ^ (v < 0 ? 1 : 0);
          const nv = neg ? -mag : mag;
          c2v[e] = nv;
          L[ridx[e]] = v + nv;
        }
      }
      ok = syndromeOk();
    }
    const bits = new Uint8Array(k);
    for (let i = 0; i < k; i++) bits[i] = L[i] < 0 ? 1 : 0;
    return { bits, ok, iters };
  }

  return { n, k, encode, decode };
}
