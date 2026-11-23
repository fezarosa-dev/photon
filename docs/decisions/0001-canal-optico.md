# 0001 — Transferência de arquivos por canal óptico (tela → câmera)

Data: 2026-11-23 · Status: aceita (piloto)

## Contexto

Objetivo: transferir arquivos entre PC e celular **sem nenhum canal de dados entre os aparelhos**:
sem Wi-Fi, Bluetooth, NFC, cabo ou servidor. A internet só pode ser usada para carregar a página.

## Decisões

1. **O canal é a luz: a tela de um aparelho e a câmera do outro.** Compará com os outros canais disponíveis ao navegador:
   som (~10 B/s), vibração e sensores (bits/s). Bluetooth entre dois navegadores é impossível,
   porque a Web Bluetooth só atua como central.
2. **Usar um código óptico próprio, com cores, em vez de QR.** É inspirado no cimbar (~106 KB/s), que não tem leitor para navegador.
   **Meta: pelo menos 200 KB/s** no sentido PC → iPhone.
3. **Hardware de referência:** iPhone 16 (Safari/WebKit) segurado na mão e na horizontal, enquadrando a tela inteira. PC com tela de 1920×1080 e Chrome.
   - Limites do Safari: plano de até 30 fps de câmera, sem trava de foco, exposição ou balanço de branco.
   - Por isso, cada quadro tem uma régua de cores.
4. **Paridade em 3 níveis, mais o hash:**
   - **Células de paridade dentro do quadro:** LDPC com decisão suave, espalhado pelo quadro, com ~30% de paridade para começar. Reed-Solomon fica como plano B.
   - **CRC por bloco:** detecta o bloco que não pôde ser corrigido.
   - **Fountain code entre quadros:** cobre quadros perdidos ou misturados.
   - **SHA-256 do arquivo inteiro** no final.
5. **Canal de mão única com calibração.**
   - O PC transmite em loop um quadro de calibração com: cabeçalho (nome, tamanho, SHA-256, sessão, parâmetros), réguas de cores e padrão de teste conhecido.
   - O loop alterna entre níveis de densidade (tamanho de célula × número de cores).
   - O celular mede o erro de cada nível e mostra "Calibrado, nível N".
   - O usuário escolhe esse nível no PC e inicia a transferência. **O humano é o canal de volta.**
6. **Detecção de quadro misturado:** o cabeçalho aparece no topo e na base do quadro. Se os dois tiverem índices de quadro diferentes, a câmera filmou a troca de quadro e a leitura é descartada.
7. **Stack:** Vite + TypeScript puro, sem framework. O HTTPS local (`@vitejs/plugin-basic-ssl`) existe porque o Safari só libera a câmera em contexto seguro.
   WebGL/WebGPU/WASM só entram se a medição mostrar gargalo.

## Fases

0. Calibração e medição do canal (este piloto)
1. Leitura robusta de um quadro (refino de geometria e cores)
2. Transferência do arquivo (LDPC + fountain + SHA-256)
3. Otimização, calibração automática e sentido celular → PC
4. PWA e publicação

## Resultados medidos: fase 0 (2026-11-23, iPhone 16 na mão)

| Câmera (pedida) | fps entregue | Processamento | Observação |
|---|---|---|---|
| 1080p | ~50–57 | ~50 | **melhor configuração** |
| 1440p | 27–30 | 8–30 | câmera limitada a 30 fps |
| 4K | 12–13 | 12–13 | o gargalo é o processamento em JS; a câmera informa 30 fps |

- **Configuração padrão: câmera em 1080p e o PC trocando 30 imagens/s.** O resultado foi "Calibrado, nível 7"
  (célula de 6 px, 4 cores, erro ≤5%), com **~207 KB/s teóricos** (30% de paridade já descontada). A vazão real
  depende do aproveitamento (imagens distintas lidas por segundo ÷ 30), que ainda falta medir.
- 4 cores são robustas, 8 cores funcionam a partir de 8 px, e 16 cores erram demais (≥19% com 8 px).
- O "sem cabeçalho" vinha do enquadramento (um canto fora da imagem), não de defeito do leitor.
- O maior erro vinha do modelo de cor: a régua fica só no topo e na base, e o brilho varia pela tela. O refinamento local
  guiado pela decisão (12×6 regiões, 2 iterações) baixou o erro num quadro 4K real de 45% para 33%, e num quadro 1080p de 0,7% para 0,1%.
- A escala (pixels de câmera por pixel de quadro) mais alta medida em 1080p foi 0,49×. Aproximar até ≥0,8× deve reduzir o erro.

## Varredura automática (`/teste`, 2026-11-23, iPhone 16 na mão, câmera em 1080p ~36 fps)

Leituras: 3988 ok, 1288 misturadas, 1023 sem cabeçalho, 1038 sem marcadores. A vazão líquida foi estimada como
bruto × taxa de código prática (85% da capacidade para o erro medido) × aproveitamento:

| Escala | Melhor combinação | Erro | Aproveitamento | Líquido est. |
|---|---|---|---|---|
| 0,5 | (nenhuma boa: erro ≥40%) | | | ~100–120 |
| 0,6 | 20 img/s · 6 px · 8 cores | 23,5% | 90% | ~136 |
| 0,7 | 20 img/s · 6 px · 8 cores | 7,1% | 80% | ~168 |
| 0,8 | 20 img/s · 6 px · 8 cores | 3,1% | 85% | ~195 |
| 0,8 | 15 img/s · 5 px · 8 cores | 12,4% | 100% | ~205 |
| 0,9 | 15 img/s · 6 px · 8 cores | 0,9% | 100% | ~183 |

| Imagens/s | Aproveitamento | Misturados |
|---|---|---|
| 30 | 44% | 45% |
| 20 | 85% | 19% |
| 15 | 98% | 18% |

Conclusões:
- **A distância é o fator principal.** Com escala ≥0,8, a meta de 200 KB/s líquidos fica ao alcance; com 0,5, cai para a metade.
- **20 imagens/s é o ponto ideal.** A 30 imagens/s, com a câmera a 36 fps, mais da metade das imagens se perde ou chega misturada.
- **8 cores com paridade mais forte (~25–35%) superam 4 cores.** 16 cores não compensam.
- Para a fase 2: o padrão passa a ser 20 imagens/s e a paridade passa a ser escolhida pelo erro medido na calibração, em vez de ficar fixa em 30%.
- O fps da câmera varia entre sessões (36 a 57 fps). A calibração precisa medir sempre.

## Fase 2: primeira transferência real (2026-11-23)

- **foto-teste.png (9.968.098 B) foi do PC para o iPhone só pela luz, com o SHA-256 conferido.** Monitor do meio,
  nível 11 (5 px, 8 cores), 20 imagens/s, escala ~0,93: **119 s, ou 82 KB/s reais**.
- O LDPC corrigiu 99,7% das palavras (10.463/10.494). O canal óptico comporta mais de 200 KB/s (~14 KB por imagem × 20/s).
- **O gargalo é o processamento no iPhone:** ~10 imagens/s numa thread só, o que aproveita só 40% das imagens mostradas.
  Próximo passo: um pool de Web Workers para ler e decodificar em paralelo.
- Fountain: só pacotes de reparo (id ≥ k). O modo sistemático exigia ~37% a mais de pacotes com perdas, contra 6–15% no reparo puro.
- A paridade é escolhida pela calibração (`pickRate`), a partir dos limites medidos do LDPC com folga de 0,7.

## Nome (2026-11-23)

O app passa a se chamar **Photon** (fóton em inglês): a partícula de luz que carrega a informação. A pasta, o pacote e a identificação do protocolo no cabeçalho também foram renomeados (`photon`, `PH`). Antes de publicar, checar disponibilidade de domínio, App Store e marca.
