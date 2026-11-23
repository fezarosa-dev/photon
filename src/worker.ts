// Worker de leitura: imagem da câmera → cantos → cabeçalho → células → (dados) LDPC + CRC.
// Vários rodam em paralelo; o fountain (com estado) fica na thread principal.
import { TYPE_DATA, decodeFrame, type Decoded } from './frame.ts';
import { decodeWords, makePlan, rxKey, type Words } from './transfer.ts';

export interface Job {
  seq: number;
  key: string;                                           // recepção atual (sessão|nível|taxa|tamanho)
  bitmap?: ImageBitmap;                                  // caminho rápido: leitura dos pixels aqui no worker
  pixels?: { data: Uint8ClampedArray; width: number; height: number }; // alternativa: pixels lidos na thread principal
  skip: number[];                                        // quadros de dados já aproveitados (não decodificar de novo)
  skipAll: boolean;                                      // arquivo já completo
}
export interface Done { seq: number; res: Omit<Decoded, 'llr' | 'wrong'>; words?: Words; ms: number }

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function pixelsOf(job: Job) {
  if (job.pixels) return job.pixels;
  const bmp = job.bitmap!;
  if (!canvas || canvas.width !== bmp.width || canvas.height !== bmp.height) {
    canvas = new OffscreenCanvas(bmp.width, bmp.height);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx!.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx!.getImageData(0, 0, canvas.width, canvas.height);
}

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data, t0 = performance.now();
  const skip = new Set(job.skip);
  const res = decodeFrame(pixelsOf(job), (h) => rxKey(h) !== job.key || (!job.skipAll && !skip.has(h.frame)));
  const { llr, wrong, ...rest } = res;
  const words = llr && res.header?.type === TYPE_DATA ? decodeWords(makePlan(res.header.config, res.header.rate!), llr) : undefined;
  const done: Done = { seq: job.seq, res: rest, words, ms: performance.now() - t0 };
  (self as unknown as Worker).postMessage(done, words ? words.payloads.map((p) => p.buffer as ArrayBuffer) : []);
};
