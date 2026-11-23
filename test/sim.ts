// Câmera simulada para os testes: perspectiva, desfoque, vazamento entre canais, ganho e ruído.
import { FW, FH, rng } from '../src/frame.ts';
import { homography, project, type Img, type Pt } from '../src/detect.ts';

export const CW = 1920, CH = 1080;
export const TILT: Pt[] = [{ x: 230, y: 160 }, { x: 1700, y: 120 }, { x: 1760, y: 960 }, { x: 190, y: 930 }];

/** corners: onde os cantos TL, TR, BR, BL do quadro aparecem na câmera. */
export function camera(px: Uint32Array, corners: Pt[], blur = 1, noise = 10): Img {
  const H = homography(corners, [{ x: 0, y: 0 }, { x: FW, y: 0 }, { x: FW, y: FH }, { x: 0, y: FH }]);
  let a = new Float32Array(CW * CH * 3);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    let r = 0, g = 0, b = 0;
    for (const sy of [0.25, 0.75]) for (const sx of [0.25, 0.75]) {
      const p = project(H, x + sx, y + sy);
      if (p.x >= 0 && p.x < FW && p.y >= 0 && p.y < FH) {
        const v = px[(p.y | 0) * FW + (p.x | 0)];
        r += v & 255; g += (v >>> 8) & 255; b += (v >>> 16) & 255;
      } else { r += 40; g += 40; b += 40; }
    }
    const o = (y * CW + x) * 3;
    a[o] = r / 4; a[o + 1] = g / 4; a[o + 2] = b / 4;
  }
  for (let pass = 0; pass < blur; pass++) { // desfoque caixa 3×3 separável
    const t = new Float32Array(a.length);
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) for (let k = 0; k < 3; k++) {
      const l = Math.max(0, x - 1), rr = Math.min(CW - 1, x + 1);
      t[(y * CW + x) * 3 + k] = (a[(y * CW + l) * 3 + k] + a[(y * CW + x) * 3 + k] + a[(y * CW + rr) * 3 + k]) / 3;
    }
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) for (let k = 0; k < 3; k++) {
      const u = Math.max(0, y - 1), d = Math.min(CH - 1, y + 1);
      a[(y * CW + x) * 3 + k] = (t[(u * CW + x) * 3 + k] + t[(y * CW + x) * 3 + k] + t[(d * CW + x) * 3 + k]) / 3;
    }
  }
  // vazamento entre canais + ganho + nível de preto + ruído
  const M = [[0.8, 0.12, 0.05], [0.08, 0.78, 0.1], [0.05, 0.14, 0.75]], rnd = rng(7);
  const out = new Uint8ClampedArray(CW * CH * 4);
  for (let i = 0; i < CW * CH; i++) {
    for (let k = 0; k < 3; k++) {
      const v = M[k][0] * a[i * 3] + M[k][1] * a[i * 3 + 1] + M[k][2] * a[i * 3 + 2];
      out[i * 4 + k] = v + 18 + ((rnd() / 2 ** 32) * 2 - 1) * noise;
    }
    out[i * 4 + 3] = 255;
  }
  return { data: out, width: CW, height: CH };
}
