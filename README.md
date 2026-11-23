# Photon

Transferência de arquivos entre computador e celular **pela luz**: a tela de um aparelho mostra o arquivo em quadros coloridos e a câmera do outro lê. Sem rede, sem cabo, sem servidor.

**Use agora:** https://fezarosa-dev.github.io/photon/

## Por quê

Passar um arquivo do computador para o celular (ou o contrário) costumava ser trabalhoso: mandar pelo WhatsApp para si mesmo, baixar do outro lado, lidar com a compressão de fotos, com cabos e com contas. O Photon resolve isso com o que os dois aparelhos já têm: uma tela e uma câmera.

O segundo objetivo é **privacidade**: o arquivo não sai dos dois aparelhos. Ele não passa por servidor, nuvem, aplicativo de mensagens, Wi-Fi, Bluetooth ou cabo. A única coisa que vem da internet é o próprio site (o código, público neste repositório). Depois de carregada a página, a transferência funciona até em modo avião.

## Como usar

1. Abra o site nos dois aparelhos.
2. No aparelho que tem o arquivo, toque em **Enviar** e escolha o arquivo. No outro, toque em **Receber**.
3. **Calibrar**: aponte a câmera para a tela. Quem recebe indica o **nível** e a **paridade** ideais para aquele par de aparelhos.
4. Escolha esses valores e toque em **Iniciar**. O arquivo chega idêntico, conferido por SHA-256, e é salvo no aparelho.

| Sentido | Câmera que lê | Velocidade típica |
|---|---|---|
| Computador → celular | câmera do celular | ~80–200 KB/s |
| Celular → computador | webcam | ~3–26 KB/s (limitada pela webcam) |

## Segurança e privacidade

- **Nenhum servidor recebe o arquivo, nem metadados dele.** O build publicado não faz nenhuma requisição além de carregar o próprio código.
- **A integridade é verificada:** o arquivo só é aceito se o SHA-256 bater com o original.
- **Código aberto:** qualquer pessoa pode auditar o que o site faz.
- **Limite honesto:** o canal é luz visível. Quem filmar a tela durante a transferência também consegue capturar os dados, porque eles ainda não são criptografados. Transfira longe de câmeras de terceiros. Criptografia com uma senha digitada nos dois aparelhos é um próximo passo possível.

## Como funciona

Cada quadro tem quatro marcadores nos cantos (para achar e endireitar a imagem), um cabeçalho em preto e branco, réguas de cor e uma grade de células coloridas com os dados.

- **Correção de erros em 3 camadas:** LDPC com decisão suave dentro de cada quadro, CRC por bloco e fountain code (LT) entre quadros. Imagens perdidas ou borradas só atrasam a transferência; não estragam o arquivo.
- **Leitura em paralelo:** um pool de Web Workers faz a leitura na câmera.
- **Calibração:** escolhe a combinação mais rápida que aquele par de aparelhos aguenta, sem nenhum canal de volta. Quem fecha o ciclo é você, ao escolher o nível indicado.

As decisões de projeto e as medições estão em [`docs/decisions/0001-canal-optico.md`](docs/decisions/0001-canal-optico.md).

## Desenvolvimento

```sh
npm install
npm run dev     # https local (o Safari do iPhone exige https para a câmera)
npm test        # testes com câmera simulada (Node 24)
npm run build
```

Cada push no `main` roda os testes e publica no GitHub Pages.
