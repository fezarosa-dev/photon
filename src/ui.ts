// Componentes de interface compartilhados: controle segmentado, ícones (traço simples, estilo SF Symbols) e formatação.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
/** Tamanho com a unidade que cabe nele (base 1024): 812 B, 2 KB, 1,9 MB, 3,2 GB — vírgula decimal pt-BR. */
export function formatBytes(n: number) {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('pt-BR', { maximumFractionDigits: i === 0 || n >= 100 ? 0 : 1 })} ${UNITS[i]}`;
}

/** Controle segmentado (rádios nativos: teclado e leitor de tela funcionam sem código extra). */
export function segmented(name: string, options: [value: string | number, label: string][], selected: string | number) {
  return `<div class="seg" role="radiogroup">${options.map(([v, l]) =>
    `<label><input type="radio" name="${name}" value="${v}"${String(v) === String(selected) ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>`;
}

export function segValue(root: ParentNode, name: string) {
  return root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value;
}

const svg = (d: string) =>
  `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON = {
  send: svg('<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'),
  receive: svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
  test: svg('<path d="M9 3h6"/><path d="M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7.5 15h9"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M9 10v10"/>'),
  reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><path d="m9.5 13.5 2.5-2.5 2.5 2.5"/><path d="M12 11v5"/>'),
  doc: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
};

const chevron = svg('<path d="m15 18-6-6 6-6"/>');
export const CHEVRON = `<span class="chev" aria-hidden="true">${svg('<path d="m9 18 6-6-6-6"/>')}</span>`;
/** Voltar ao início: recarrega a página (para câmera, workers e tela cheia de uma vez). */
export const BACK = `<button class="back" data-back aria-label="Voltar ao início">${chevron}<span>Início</span></button>`;
export const BACK_CAM = `<button class="icon-btn glass back-cam" data-back aria-label="Voltar ao início">${chevron}</button>`;
export function wireBack(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('[data-back]').forEach((b) => { b.onclick = () => location.reload(); });
}
