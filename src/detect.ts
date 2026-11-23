// Localiza os 4 marcadores (padrão 1:1:3:1:1, claro sobre escuro) e calcula a homografia quadro → imagem.

export interface Pt { x: number; y: number }
export interface Img { data: Uint8ClampedArray; width: number; height: number }
export type Mat = Float64Array;

/** Homografia 3×3 que leva src[i] → dst[i] (4 pares, DLT + eliminação de Gauss). */
export function homography(src: Pt[], dst: Pt[]): Mat {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return Float64Array.of(...A.map((row, i) => row[8] / row[i]), 1);
}

export function project(H: Mat, x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

const ratioOk = (a: number, b: number, c: number, d: number, e: number) => {
  const total = a + b + c + d + e;
  if (total < 7) return false;
  const u = total / 7, tol = u * 0.6;
  return Math.abs(a - u) < tol && Math.abs(b - u) < tol && Math.abs(c - 3 * u) < u * 1.5
    && Math.abs(d - u) < tol && Math.abs(e - u) < tol;
};

/** Confirma o padrão na vertical, a partir de um ponto no centro claro. Retorna o y do centro. */
function crossV(bin: Uint8Array, w: number, h: number, x: number, y: number, total: number): number | null {
  const max = total * 1.5;
  const walk = (dir: number, from: number) => {
    const runs = [0, 0, 0];
    let yy = from;
    for (let k = 0, want = 1; k < 3; k++, want ^= 1) {
      while (yy >= 0 && yy < h && bin[yy * w + x] === want && runs[k] < max) { runs[k]++; yy += dir; }
    }
    return runs;
  };
  const [cu, bu, au] = walk(-1, y);
  const [cd, bd, ad] = walk(1, y + 1);
  const c = cu + cd;
  if (!ratioOk(au, bu, c, bd, ad)) return null;
  const vt = au + bu + c + bd + ad;
  if (vt < total * 0.5 || vt > total * 2) return null;
  return y - cu + 1 + c / 2;
}

/** Centro sub-pixel: centróide dos pixels claros do miolo do marcador, na resolução cheia. */
function refine(img: Img, x: number, y: number, u: number): Pt {
  const { data, width, height } = img, r = 2 * u;
  const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(width, Math.ceil(x + r));
  const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(height, Math.ceil(y + r));
  let lo = Infinity, hi = -Infinity;
  for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) {
    const k = (j * width + i) * 4, l = data[k] + 2 * data[k + 1] + data[k + 2];
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  const t = (lo + hi) / 2;
  let sx = 0, sy = 0, n = 0;
  for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) {
    const k = (j * width + i) * 4;
    if (data[k] + 2 * data[k + 1] + data[k + 2] > t) { sx += i + 0.5; sy += j + 0.5; n++; }
  }
  return n ? { x: sx / n, y: sy / n } : { x, y };
}

/** 4 centros de marcador em ordem horária na imagem (rotação inicial indefinida), ou null. */
export function findAnchors(img: Img): Pt[] | null {
  const W = img.width, d = img.data, w = W >> 1, h = img.height >> 1;

  // cinza em meia resolução
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = (2 * y * W + 2 * x) * 4, b = a + 4, c = a + W * 4, e = c + 4;
    gray[y * w + x] = (d[a] + 2 * d[a + 1] + d[a + 2] + d[b] + 2 * d[b + 1] + d[b + 2]
      + d[c] + 2 * d[c + 1] + d[c + 2] + d[e] + 2 * d[e + 1] + d[e + 2]) >> 4;
  }

  // binarização adaptativa (média local por imagem integral)
  const iw = w + 1, integ = new Uint32Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += gray[y * w + x]; integ[(y + 1) * iw + x + 1] = integ[y * iw + x + 1] + row; }
  }
  const R = Math.max(8, Math.round(Math.min(w, h) / 20));
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(h, y + R + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(w, x + R + 1);
      const s = integ[y1 * iw + x1] - integ[y0 * iw + x1] - integ[y1 * iw + x0] + integ[y0 * iw + x0];
      bin[y * w + x] = gray[y * w + x] > s / ((x1 - x0) * (y1 - y0)) + 6 ? 1 : 0;
    }
  }

  // varredura das linhas
  const cands: { x: number; y: number; u: number; n: number }[] = [];
  const add = (x: number, y: number, u: number) => {
    for (const c of cands) {
      if (Math.abs(c.x / c.n - x) < u * 3 && Math.abs(c.y / c.n - y) < u * 3) { c.x += x; c.y += y; c.u += u; c.n++; return; }
    }
    cands.push({ x, y, u, n: 1 });
  };
  const rs = new Int32Array(w), rl = new Int32Array(w), rc = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let n = 0;
    for (let x = 0; x < w;) {
      const c = bin[row + x];
      let e = x;
      while (e < w && bin[row + e] === c) e++;
      rs[n] = x; rl[n] = e - x; rc[n] = c; n++;
      x = e;
    }
    for (let k = 0; k + 4 < n; k++) {
      if (!rc[k]) continue;
      const a = rl[k], b = rl[k + 1], c = rl[k + 2], dd = rl[k + 3], e = rl[k + 4];
      if (!ratioOk(a, b, c, dd, e)) continue;
      const total = a + b + c + dd + e, cx = rs[k + 2] + c / 2;
      if (total / 7 < 2) continue;
      const cy = crossV(bin, w, h, Math.floor(cx), y, total);
      if (cy !== null) add(cx, cy, total / 7);
    }
  }

  const best = cands.filter((c) => c.n >= 3).sort((a, b) => b.n - a.n).slice(0, 4);
  if (best.length < 4) return null;
  const pts = best.map((c) => ({ x: c.x / c.n, y: c.y / c.n, u: c.u / c.n }));
  const us = pts.map((p) => p.u);
  if (Math.max(...us) > 2.5 * Math.min(...us)) return null;

  const mx = pts.reduce((s, p) => s + p.x, 0) / 4, my = pts.reduce((s, p) => s + p.y, 0) / 4;
  pts.sort((a, b) => Math.atan2(a.y - my, a.x - mx) - Math.atan2(b.y - my, b.x - mx));
  return pts.map((p) => refine(img, p.x * 2, p.y * 2, p.u * 2));
}
