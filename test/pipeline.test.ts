// Teste ponta a ponta sem celular: desenha o quadro, simula uma câmera torta/borrada/com cor errada e lê de volta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIGS, FW, FH, TYPE_CALIB, decodeFrame, render, type Header } from '../src/frame.ts';
import { CH, CW, TILT, camera } from './sim.ts';

const header = (config: number): Header => ({
  type: TYPE_CALIB, config, fps: 15, session: 0xdeadbeef, frame: 42 + config,
  size: 10_485_760, sha: Uint8Array.from({ length: 32 }, (_, i) => i * 7), name: 'relatório-final.pdf',
});

function frame(config: number) {
  const px = new Uint32Array(FW * FH);
  render(px, header(config));
  return px;
}

function assertHeader(got: Header | undefined, config: number) {
  const want = header(config);
  assert.ok(got);
  assert.equal(got.name, want.name);
  assert.equal(got.size, want.size);
  assert.equal(got.frame, want.frame);
  assert.equal(got.session, want.session);
  assert.equal(got.config, config);
  assert.deepEqual([...got.sha], [...want.sha]);
}

test('quadro inclinado: lê cabeçalho e células do nível robusto sem erro', () => {
  const res = decodeFrame(camera(frame(0), TILT));
  assert.equal(res.status, 'ok');
  assertHeader(res.header, 0);
  assert.ok(res.errors! / res.cells! < 0.01, `erro ${res.errors}/${res.cells}`);
});

test('celular de ponta-cabeça (180°): rotação resolvida pelo CRC', () => {
  const res = decodeFrame(camera(frame(0), [TILT[2], TILT[3], TILT[0], TILT[1]]));
  assert.equal(res.status, 'ok');
  assertHeader(res.header, 0);
});

test('sem quadro na imagem: não inventa marcadores', () => {
  const img = { data: new Uint8ClampedArray(CW * CH * 4).fill(60), width: CW, height: CH };
  assert.equal(decodeFrame(img).status, 'sem-marcadores');
});

test('quadro misturado (topo de uma imagem, base de outra) é descartado', () => {
  const a = frame(0), b = new Uint32Array(FW * FH);
  render(b, { ...header(0), frame: 999 });
  a.set(b.subarray((FH / 2) * FW), (FH / 2) * FW);
  assert.equal(decodeFrame(camera(a, TILT)).status, 'misturado');
});

test('todos os níveis: cabeçalho lido; mostra taxa de erro simulada', () => {
  const rows: string[] = [];
  CONFIGS.forEach((c, i) => {
    const res = decodeFrame(camera(frame(i), TILT));
    assert.equal(res.status, 'ok', `nível ${i + 1}`);
    assertHeader(res.header, i);
    rows.push(`nível ${i + 1}: célula ${c.cell}px ${c.colors} cores → erro ${((100 * res.errors!) / res.cells!).toFixed(2)}%`);
  });
  console.log(rows.join('\n'));
});

test('cantos voltam na ordem do quadro: dá o ângulo da tela na imagem (giro do painel)', () => {
  const angle = (corners: typeof TILT) => {
    const a = decodeFrame(camera(frame(0), corners)).anchors!;
    return (Math.round((Math.atan2(a[1].y - a[0].y, a[1].x - a[0].x) * 180) / Math.PI / 90) * 90 + 360) % 360;
  };
  assert.equal(angle(TILT), 0);                                  // tela em pé
  assert.equal(angle([TILT[2], TILT[3], TILT[0], TILT[1]]), 180); // celular de ponta-cabeça
});

test('câmera espelhada (webcam): quadro lido mesmo assim', () => {
  // espelho horizontal: o canto TL do quadro aparece onde estaria o TR, e assim por diante
  const res = decodeFrame(camera(frame(0), [TILT[1], TILT[0], TILT[3], TILT[2]]));
  assert.equal(res.status, 'ok');
  assert.equal(res.mirrored, true); // a prévia do PC usa isso para não espelhar duas vezes
  assert.equal(decodeFrame(camera(frame(0), TILT)).mirrored, false);
  assertHeader(res.header, 0);
  assert.ok(res.errors! / res.cells! < 0.01, `erro ${res.errors}/${res.cells}`);
});
