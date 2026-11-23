// Layout do quadro óptico em "pixels de quadro" (1920×1080), desenho e leitura.
// O emissor desenha 1:1; o receptor mapeia quadro → imagem da câmera por homografia.
import { findAnchors, homography, project, type Img, type Mat, type Pt } from './detect.ts';

export const FW = 1920;
export const FH = 1080;
const MOD = 16;                        // módulo do marcador e célula do cabeçalho
const Q = MOD;                         // margem escura em volta dos marcadores
const ANCHOR = 7 * MOD;                // marcador 7×7 módulos
const BAND = Q + ANCHOR + MOD;         // altura da faixa de cabeçalho (144)
const HDR_X0 = BAND;
const HDR_COLS = (FW - 2 * BAND) / MOD; // 102
const HDR_ROWS = ANCHOR / MOD;          // 7
const HDR_CELLS = HDR_COLS * HDR_ROWS;  // 714 bits por faixa
const HDR_TOP_Y = Q;
const HDR_BOT_Y = FH - Q - ANCHOR;
const PAL_TOP_Y = BAND;                 // régua de cores superior
const PAL_BOT_Y = FH - BAND - MOD;      // régua de cores inferior
const CELL_Y0 = BAND + MOD;
const CELL_Y1 = FH - BAND - MOD;
const BINS = 6;                         // faixas horizontais da régua (tela/câmera não são uniformes)
const LBX = 12, LBY = 6;                // regiões do refinamento local de cor
const REFINE_ITERS = 2;
const PARITY = 0.3;                     // ponytail: fração reservada p/ paridade (LDPC, fase 2); ajustar com dados reais

/** Centros dos marcadores no quadro, em ordem horária: TL, TR, BR, BL. */
export const ANCHOR_CENTERS: Pt[] = [
  { x: Q + ANCHOR / 2, y: Q + ANCHOR / 2 },
  { x: FW - Q - ANCHOR / 2, y: Q + ANCHOR / 2 },
  { x: FW - Q - ANCHOR / 2, y: FH - Q - ANCHOR / 2 },
  { x: Q + ANCHOR / 2, y: FH - Q - ANCHOR / 2 },
];

type RGB = [number, number, number];
const PAL4: RGB[] = [[255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
const PAL8: RGB[] = [];
for (const r of [0, 255]) for (const g of [0, 255]) for (const b of [0, 255]) PAL8.push([r, g, b]);
const PAL16: RGB[] = []; // verde com 4 níveis (canal mais sensível da câmera), em ordem Gray
for (const r of [0, 255]) for (const g of [0, 85, 255, 170]) for (const b of [0, 255]) PAL16.push([r, g, b]);
const PALETTES: Record<number, RGB[]> = { 4: PAL4, 8: PAL8, 16: PAL16 };

export interface Config { cell: number; colors: number }
/**
 * Níveis de densidade: tamanho da célula (px de quadro) × nº de cores. O índice vai no cabeçalho.
 * FINE: tela grande → câmera boa (PC → celular). COARSE: tela pequena → webcam (celular → PC), células até 8× maiores.
 */
export const CONFIGS: Config[] = [
  ...[10, 8, 6, 5].flatMap((cell) => [4, 8, 16].map((colors) => ({ cell, colors }))),
  ...[40, 32, 24, 16, 12].flatMap((cell) => [4, 8].map((colors) => ({ cell, colors }))),
];
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
export const FINE = range(0, 12);
export const COARSE = range(12, CONFIGS.length);
export const profileOf = (config: number) => (config >= FINE.length ? COARSE : FINE);
/** Número do nível mostrado ao usuário: posição dentro do perfil (1, 2, 3…). */
export const levelNumber = (config: number) => profileOf(config).indexOf(config) + 1;

export function grid(c: Config) {
  const cols = Math.floor(FW / c.cell), rows = Math.floor((CELL_Y1 - CELL_Y0) / c.cell);
  return {
    cols, rows,
    x0: Math.floor((FW - cols * c.cell) / 2),
    y0: CELL_Y0 + Math.floor((CELL_Y1 - CELL_Y0 - rows * c.cell) / 2),
  };
}
export const bitsOf = (c: Config) => Math.log2(c.colors);

/** Vazão bruta (KB/s) de um nível, sem descontar paridade. */
export function rawKbps(c: Config, fps: number) {
  const g = grid(c);
  return (g.cols * g.rows * bitsOf(c)) / 8 / 1024 * fps;
}

/** Vazão útil estimada (KB/s) de um nível, descontada a paridade. */
export function kbps(c: Config, fps: number) {
  const g = grid(c);
  return (g.cols * g.rows * bitsOf(c) * (1 - PARITY)) / 8 / 1024 * fps;
}

// ---------- cabeçalho ----------

export interface Header {
  type: number; config: number; fps: number; session: number; frame: number;
  size: number; sha: Uint8Array; name: string;
  rate?: number;  // dados: taxa do LDPC (k/n); 0 nos quadros de calibração/teste
  flags?: number; // dados: FLAG_DEFLATE se o conteúdo foi comprimido
  plen?: number;  // dados: tamanho do conteúdo transmitido (após compressão)
}
export const TYPE_CALIB = 1;
export const TYPE_TEST = 2; // varredura automática (/teste): fps e nível mudam a cada bloco
export const TEST_FPS = [30, 20, 15]; // imagens/s varridas no teste
export const TYPE_DATA = 3;
export const FLAG_DEFLATE = 1;
const HEADER_BYTES = 85;
const NAME_MAX = 20;
const VERSION = 2;

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** mulberry32: PRNG determinístico, igual nos dois lados. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function utf8Prefix(s: string, max: number) {
  const e = new TextEncoder().encode(s);
  if (e.length <= max) return e;
  let n = max;
  while (n > 0 && (e[n] & 0xc0) === 0x80) n--; // não corta caractere multibyte ao meio
  return e.slice(0, n);
}

function packHeader(h: Header): Uint8Array {
  const b = new Uint8Array(HEADER_BYTES), dv = new DataView(b.buffer);
  // identificação do protocolo: 'PH' (Photon)
  b[0] = 0x50; b[1] = 0x48; b[2] = VERSION; b[3] = h.type; b[4] = h.config; b[5] = h.fps;
  dv.setUint32(6, h.session);
  dv.setUint32(10, h.frame);
  dv.setBigUint64(14, BigInt(h.size));
  b.set(h.sha.subarray(0, 32), 22);
  const name = utf8Prefix(h.name, NAME_MAX);
  b[54] = name.length;
  b.set(name, 55);
  b[75] = Math.round((h.rate ?? 0) * 200);
  b[76] = h.flags ?? 0;
  dv.setUint32(77, h.plen ?? 0);
  dv.setUint32(81, crc32(b.subarray(0, 81)));
  return b;
}

function unpackHeader(b: Uint8Array): Header | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] !== 0x50 || b[1] !== 0x48 || b[2] !== VERSION) return null;
  if (dv.getUint32(81) !== crc32(b.subarray(0, 81))) return null;
  if (b[4] >= CONFIGS.length) return null;
  return {
    type: b[3], config: b[4], fps: b[5], session: dv.getUint32(6), frame: dv.getUint32(10),
    size: Number(dv.getBigUint64(14)), sha: b.slice(22, 54),
    name: new TextDecoder().decode(b.subarray(55, 55 + Math.min(b[54], NAME_MAX))),
    rate: b[75] / 200, flags: b[76], plen: dv.getUint32(77),
  };
}

// branqueamento: ~50% de células claras, para o limiar pela média funcionar
const WHITEN = (() => { const r = rng(0x51460001); return Uint8Array.from({ length: HDR_CELLS }, () => r() >>> 31); })();

function headerBits(b: Uint8Array) {
  const bits = new Uint8Array(HDR_CELLS);
  for (let i = 0; i < HDR_CELLS; i++) {
    const d = i < b.length * 8 ? (b[i >> 3] >> (7 - (i & 7))) & 1 : 0;
    bits[i] = d ^ WHITEN[i];
  }
  return bits;
}

function bitsToBytes(bits: Uint8Array) {
  const b = new Uint8Array(HEADER_BYTES);
  for (let i = 0; i < HEADER_BYTES * 8; i++) b[i >> 3] |= (bits[i] ^ WHITEN[i]) << (7 - (i & 7));
  return b;
}

/** Símbolos conhecidos da área de teste (calibração): derivados de sessão + índice do quadro. */
export function symbols(h: Header, c: Config) {
  const { cols, rows } = grid(c), shift = 32 - bitsOf(c);
  const r = rng((h.session ^ Math.imul(h.frame + 1, 0x9e3779b1)) >>> 0);
  return Uint8Array.from({ length: cols * rows }, () => r() >>> shift);
}

export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// ---------- desenho ----------

const pack = ([r, g, b]: RGB) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0; // RGBA little-endian
const WHITE = pack([255, 255, 255]), BLACK = pack([0, 0, 0]);

/** Desenha o quadro em px (FW×FH, RGBA em Uint32 little-endian). Sem `syms`, usa o padrão de teste conhecido. */
export function render(px: Uint32Array, h: Header, syms?: Uint8Array) {
  const c = CONFIGS[h.config], pal = PALETTES[c.colors].map(pack);
  const rect = (x: number, y: number, w: number, hh: number, v: number) => {
    for (let j = y; j < y + hh; j++) px.fill(v, j * FW + x, j * FW + x + w);
  };
  px.fill(BLACK);
  for (const a of ANCHOR_CENTERS) {
    const x = a.x - ANCHOR / 2, y = a.y - ANCHOR / 2;
    rect(x, y, ANCHOR, ANCHOR, WHITE);
    rect(x + MOD, y + MOD, 5 * MOD, 5 * MOD, BLACK);
    rect(x + 2 * MOD, y + 2 * MOD, 3 * MOD, 3 * MOD, WHITE);
  }
  const bits = headerBits(packHeader(h));
  for (const y0 of [HDR_TOP_Y, HDR_BOT_Y]) {
    for (let i = 0; i < HDR_CELLS; i++) {
      if (bits[i]) rect(HDR_X0 + (i % HDR_COLS) * MOD, y0 + Math.floor(i / HDR_COLS) * MOD, MOD, MOD, WHITE);
    }
  }
  for (const y of [PAL_TOP_Y, PAL_BOT_Y]) {
    for (let k = 0; k < FW / MOD; k++) rect(k * MOD, y, MOD, MOD, pal[k % pal.length]);
  }
  const g = grid(c), s = syms ?? symbols(h, c);
  for (let j = 0; j < g.rows; j++) {
    for (let i = 0; i < g.cols; i++) rect(g.x0 + i * c.cell, g.y0 + j * c.cell, c.cell, c.cell, pal[s[j * g.cols + i]]);
  }
}

// ---------- leitura ----------

/** Amostra bilinear (coordenadas contínuas: pixel k ocupa [k, k+1)). */
function sample(img: Img, x: number, y: number, out: number[]) {
  const { data, width, height } = img;
  const fx = Math.min(Math.max(x - 0.5, 0), width - 1.001), fy = Math.min(Math.max(y - 0.5, 0), height - 1.001);
  const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
  const i00 = (y0 * width + x0) * 4, i10 = i00 + 4, i01 = i00 + width * 4, i11 = i01 + 4;
  for (let k = 0; k < 3; k++) {
    const top = data[i00 + k] + (data[i10 + k] - data[i00 + k]) * ax;
    const bot = data[i01 + k] + (data[i11 + k] - data[i01 + k]) * ax;
    out[k] = top + (bot - top) * ay;
  }
}

/** Projeta (x,y) do quadro na imagem e soma w×RGB bilinear em out[o..o+2]. Sem alocação (laço quente). */
function addSample(img: Img, H: Mat, x: number, y: number, w: number, out: Float32Array, o: number) {
  const { data, width, height } = img, d = H[6] * x + H[7] * y + H[8];
  const fx = Math.min(Math.max((H[0] * x + H[1] * y + H[2]) / d - 0.5, 0), width - 1.001);
  const fy = Math.min(Math.max((H[3] * x + H[4] * y + H[5]) / d - 0.5, 0), height - 1.001);
  const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
  const i00 = (y0 * width + x0) * 4, i10 = i00 + 4, i01 = i00 + width * 4, i11 = i01 + 4;
  const w00 = (1 - ax) * (1 - ay) * w, w10 = ax * (1 - ay) * w, w01 = (1 - ax) * ay * w, w11 = ax * ay * w;
  out[o] += data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
  out[o + 1] += data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
  out[o + 2] += data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
}

function readHeader(img: Img, H: Mat, y0: number): Header | null {
  const lum = new Float32Array(HDR_CELLS), c = [0, 0, 0];
  let sum = 0;
  for (let i = 0; i < HDR_CELLS; i++) {
    const p = project(H, HDR_X0 + (i % HDR_COLS + 0.5) * MOD, y0 + (Math.floor(i / HDR_COLS) + 0.5) * MOD);
    sample(img, p.x, p.y, c);
    sum += lum[i] = c[0] + 2 * c[1] + c[2];
  }
  const t = sum / HDR_CELLS;
  return unpackHeader(bitsToBytes(Uint8Array.from(lum, (v) => (v > t ? 1 : 0))));
}

const OFFS4 = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
const OFFS5 = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];

/** Cor de cada célula e classificação: régua do próprio quadro + refinamento local de cor. */
function classify(img: Img, H: Mat, cfg: Config) {
  const n = cfg.colors, g = grid(cfg), c = [0, 0, 0];

  // centróides por (régua topo/base) × faixa horizontal × cor
  const cent = new Float32Array(2 * BINS * n * 3), cnt = new Float32Array(2 * BINS * n);
  for (let row = 0; row < 2; row++) {
    const y = (row ? PAL_BOT_Y : PAL_TOP_Y) + MOD / 2;
    for (let k = 0; k < FW / MOD; k++) {
      const x = k * MOD + MOD / 2, bin = Math.min(BINS - 1, Math.floor((x * BINS) / FW));
      const o = (row * BINS + bin) * n + (k % n);
      for (const [dx, dy] of OFFS4) addSample(img, H, x + dx * MOD * 0.25, y + dy * MOD * 0.25, 1, cent, o * 3);
      cnt[o] += 4;
    }
  }
  for (let o = 0; o < cnt.length; o++) for (let k = 0; k < 3; k++) cent[o * 3 + k] /= cnt[o] || 1;

  const yTop = PAL_TOP_Y + MOD / 2, ySpan = PAL_BOT_Y - PAL_TOP_Y;
  const N = g.rows * g.cols, col = new Float32Array(N * 3), lab = new Uint8Array(N), ref = [0, 0, 0];
  const binOf = (i: number) => Math.min(BINS - 1, Math.floor(((g.x0 + (i + 0.5) * cfg.cell) * BINS) / FW));
  const tOf = (j: number) => (g.y0 + (j + 0.5) * cfg.cell - yTop) / ySpan;
  const palRef = (s: number, bin: number, t: number) => { // régua interpolada entre topo e base
    const a = (bin * n + s) * 3, z = ((BINS + bin) * n + s) * 3;
    for (let k = 0; k < 3; k++) ref[k] = cent[a + k] + (cent[z + k] - cent[a + k]) * t;
    return ref;
  };

  // cor de cada célula (média de 5 amostras) + classificação inicial pela régua
  for (let j = 0; j < g.rows; j++) {
    const y = g.y0 + (j + 0.5) * cfg.cell, t = tOf(j);
    for (let i = 0; i < g.cols; i++) {
      const x = g.x0 + (i + 0.5) * cfg.cell, bin = binOf(i), o = (j * g.cols + i) * 3, sd = cfg.cell * 0.2;
      addSample(img, H, x, y, 0.2, col, o);
      addSample(img, H, x - sd, y, 0.2, col, o);
      addSample(img, H, x + sd, y, 0.2, col, o);
      addSample(img, H, x, y - sd, 0.2, col, o);
      addSample(img, H, x, y + sd, 0.2, col, o);
      let best = 0, bd = Infinity;
      for (let s = 0; s < n; s++) {
        const q = palRef(s, bin, t), d = (col[o] - q[0]) ** 2 + (col[o + 1] - q[1]) ** 2 + (col[o + 2] - q[2]) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
      lab[j * g.cols + i] = best;
    }
  }

  // refinamento local guiado pela decisão: reaprende a cor de cada símbolo por região
  // a partir das próprias células classificadas (brilho/cor variam pela tela), sem custo de espaço
  const NB = LBX * LBY, bc = new Float32Array(NB * n * 3), bn = new Float32Array(NB * n);
  const blockOf = (i: number, j: number) => Math.floor((j * LBY) / g.rows) * LBX + Math.floor((i * LBX) / g.cols);
  const cellBlock = new Uint16Array(N);
  for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) cellBlock[j * g.cols + i] = blockOf(i, j);
  for (let it = 0; it < REFINE_ITERS; it++) {
    bc.fill(0); bn.fill(0);
    for (let cell = 0; cell < N; cell++) {
      const o = cellBlock[cell] * n + lab[cell];
      bc[o * 3] += col[cell * 3]; bc[o * 3 + 1] += col[cell * 3 + 1]; bc[o * 3 + 2] += col[cell * 3 + 2];
      bn[o]++;
    }
    // média por região; símbolo raro na região (<3 células) cai na régua, avaliada no centro da região
    for (let b = 0; b < NB; b++) {
      const bin = Math.min(BINS - 1, Math.floor((((b % LBX) + 0.5) * BINS) / LBX)), tc = (Math.floor(b / LBX) + 0.5) / LBY;
      for (let s = 0; s < n; s++) {
        const o = b * n + s, m = bn[o];
        if (m >= 3) for (let k = 0; k < 3; k++) bc[o * 3 + k] /= m;
        else { const q = palRef(s, bin, tc); for (let k = 0; k < 3; k++) bc[o * 3 + k] = q[k]; }
      }
    }
    for (let cell = 0; cell < N; cell++) {
      const base = cellBlock[cell] * n * 3, r = col[cell * 3], gg = col[cell * 3 + 1], bb = col[cell * 3 + 2];
      let best = 0, bd = Infinity;
      for (let s = 0; s < n; s++) {
        const o = base + s * 3, d = (r - bc[o]) ** 2 + (gg - bc[o + 1]) ** 2 + (bb - bc[o + 2]) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
      lab[cell] = best;
    }
  }

  return { n, N, col, lab, bc, cellBlock };
}
type Classified = ReturnType<typeof classify>;

/** Calibração/teste: conta erros contra o padrão conhecido. */
function measure(cls: Classified, h: Header) {
  const expect = symbols(h, CONFIGS[h.config]);
  let errors = 0;
  const wrong = new Uint8Array(cls.N); // mapa de erros (diagnóstico)
  for (let k = 0; k < cls.N; k++) if (cls.lab[k] !== expect[k]) { errors++; wrong[k] = 1; }
  return { errors, cells: cls.N, wrong };
}

const LLR_MAX = 20;

/**
 * Dados: LLR por bit (positivo = bit 0 mais provável), max-log sobre as distâncias aos centróides locais.
 * Bit t da célula = bit (b-1-t) do símbolo; ruído estimado pela distância média ao centróide escolhido.
 */
function softBits(cls: Classified) {
  const { n, N, col, lab, bc, cellBlock } = cls, b = Math.log2(n), d = new Float32Array(n);
  let s2 = 0;
  for (let cell = 0; cell < N; cell++) {
    const o = (cellBlock[cell] * n + lab[cell]) * 3;
    s2 += (col[cell * 3] - bc[o]) ** 2 + (col[cell * 3 + 1] - bc[o + 1]) ** 2 + (col[cell * 3 + 2] - bc[o + 2]) ** 2;
  }
  const k = 1 / (2 * Math.max(s2 / (3 * N), 1)), llr = new Float32Array(N * b);
  for (let cell = 0; cell < N; cell++) {
    const base = cellBlock[cell] * n * 3, r = col[cell * 3], g = col[cell * 3 + 1], bl = col[cell * 3 + 2];
    for (let s = 0; s < n; s++) { const o = base + s * 3; d[s] = (r - bc[o]) ** 2 + (g - bc[o + 1]) ** 2 + (bl - bc[o + 2]) ** 2; }
    for (let t = 0; t < b; t++) {
      const mask = 1 << (b - 1 - t);
      let d0 = Infinity, d1 = Infinity;
      for (let s = 0; s < n; s++) if (s & mask) { if (d[s] < d1) d1 = d[s]; } else if (d[s] < d0) d0 = d[s];
      llr[cell * b + t] = Math.max(-LLR_MAX, Math.min(LLR_MAX, (d1 - d0) * k));
    }
  }
  return llr;
}

export type Status = 'sem-marcadores' | 'sem-cabecalho' | 'misturado' | 'ok';
export interface Decoded {
  status: Status; anchors: Pt[] | null; header?: Header; errors?: number; cells?: number; wrong?: Uint8Array;
  llr?: Float32Array; // quadros de dados: bits suaves, na ordem das células
  mirrored?: boolean; // a câmera já entrega a imagem espelhada
}

/** wantData: decide se vale ler as células de um quadro de dados (ex.: pular quadro já aproveitado). */
export function decodeFrame(img: Img, wantData: (h: Header) => boolean = () => true): Decoded {
  const anchors = findAnchors(img);
  if (!anchors) return { status: 'sem-marcadores', anchors: null };
  // orientação desconhecida: 4 rotações × (normal | espelhado — webcams costumam espelhar); o CRC decide
  for (let r = 0; r < 8; r++) {
    const ordered = [0, 1, 2, 3].map((i) => anchors[r < 4 ? (i + r) % 4 : (r - i + 4) % 4]); // TL, TR, BR, BL do quadro
    const H = homography(ANCHOR_CENTERS, ordered);
    const top = readHeader(img, H, HDR_TOP_Y);
    if (!top) continue;
    const bot = readHeader(img, H, HDR_BOT_Y);
    // topo e base com quadros diferentes = câmera filmou a troca de imagem
    const mirrored = r >= 4;
    if (!bot || bot.frame !== top.frame || bot.session !== top.session) return { status: 'misturado', anchors: ordered, header: top, mirrored };
    if (top.type === TYPE_DATA) {
      return { status: 'ok', anchors: ordered, header: top, mirrored, llr: wantData(top) ? softBits(classify(img, H, CONFIGS[top.config])) : undefined };
    }
    return { status: 'ok', anchors: ordered, header: top, mirrored, ...measure(classify(img, H, CONFIGS[top.config]), top) };
  }
  return { status: 'sem-cabecalho', anchors };
}
