<h1 align="center">Photon</h1>

<p align="center">
  Transferência de arquivos entre computador e celular <b>pela luz</b>.<br>
  A tela de um aparelho mostra o arquivo em quadros coloridos e a câmera do outro lê.<br>
  Sem rede, sem cabo, sem servidor.
</p>

<p align="center">
  <a href="https://fezarosa-dev.github.io/photon/"><img alt="Abrir o app" src="https://img.shields.io/badge/abrir_o_app-online-0a84ff?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="https://github.com/fezarosa-dev/photon/actions/workflows/pages.yml"><img alt="Publicação" src="https://github.com/fezarosa-dev/photon/actions/workflows/pages.yml/badge.svg"></a>
  <img alt="Privacidade: nada sai dos aparelhos" src="https://img.shields.io/badge/privacidade-nada_sai_dos_aparelhos-30d158">
  <img alt="Dependências em produção: 0" src="https://img.shields.io/badge/depend%C3%AAncias_em_produ%C3%A7%C3%A3o-0-30d158">
  <img alt="TypeScript 7" src="https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white">
  <img alt="Vite 8" src="https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white">
  <img alt="Testes em Node 24" src="https://img.shields.io/badge/testes-Node_24-5fa04e?logo=nodedotjs&logoColor=white">
  <img alt="Roda no navegador: Android, iPhone e PC" src="https://img.shields.io/badge/roda_no_navegador-Android_·_iPhone_·_PC-8e8e93">
</p>

## Por quê

Passar um arquivo do computador para o celular (ou o contrário) costumava ser trabalhoso: mandar pelo WhatsApp para si mesmo, baixar do outro lado, lidar com a compressão de fotos, com cabos e com contas. O Photon resolve isso com o que os dois aparelhos já têm: uma tela e uma câmera.

O segundo objetivo é **privacidade**: o arquivo não sai dos dois aparelhos. Ele não passa por servidor, nuvem, aplicativo de mensagens, Wi-Fi, Bluetooth ou cabo. A única coisa que vem da internet é o próprio site (o código, público neste repositório). Depois de carregada a página, a transferência funciona até em modo avião.

## Como usar

1. Abra o site nos dois aparelhos: Android, iPhone ou computador, em qualquer navegador moderno com câmera. Não precisa instalar nada.
2. No aparelho que tem o arquivo, toque em **Enviar** e escolha o arquivo. No outro, toque em **Receber**.
3. **Calibrar**: aponte a câmera para a tela. Quem recebe indica o **nível** e a **paridade** ideais para aquele par de aparelhos.
4. Escolha esses valores e toque em **Iniciar**. O arquivo chega idêntico, conferido por SHA-256, e é salvo no aparelho.

| Sentido | Câmera que lê | Velocidade típica |
|---|---|---|
| Computador → celular | câmera do celular | ~80–200 KB/s |
| Celular → computador | webcam | ~3–26 KB/s (limitada pela webcam) |

**Testado em:** iPhone 16 (Safari) e PC (Chrome, Linux). No Android (Chrome), o app usa as mesmas APIs da web (câmera, tela cheia, workers); a validação num aparelho real está pendente.

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

## O que aprendemos

O Photon também foi um estudo de **como os dados viajam**. No fundo, ele é um pequeno sistema de telecomunicações, com as mesmas peças da internet, do Wi-Fi e do 4G. Só o meio muda: luz de tela entrando numa câmera.

**Digital × analógico.** O arquivo é digital: uma sequência exata de 0s e 1s. O meio físico é sempre analógico: luz, tensão e ondas de rádio são contínuas, com ruído e borrão. Toda comunicação digital resolve o mesmo problema, que é levar valores exatos por um meio impreciso usando poucos níveis bem separados. No Photon, cada cor é um nível. A câmera mede um tom meio borrado e o receptor decide qual cor aquilo provavelmente era. Por isso o arquivo chega idêntico mesmo com a imagem tremida.

**Do "liga e desliga" a vários níveis.** O mais simples é luz ligada = 1 e desligada = 0, como na fibra óptica básica. Wi-Fi e 4G levam vários bits por símbolo, combinando amplitude e fase da onda. O Photon faz o mesmo com cores: 4 cores = 2 bits por quadradinho, 8 cores = 3 bits. Os testes mostraram o limite disso na prática: com 16 cores, o erro dispara. É a lei de Shannon, segundo a qual o ruído do canal limita quanta informação cabe nele.

**As mesmas peças:**

| Na internet / Wi-Fi / 4G | No Photon |
|---|---|
| Compressão | deflate, quando o arquivo encolhe |
| Modulação (bits → onda) | bits → cores das células |
| Preâmbulo e sincronismo | marcadores dos cantos + cabeçalho |
| Estimativa de canal (sinais-piloto) | réguas de cor e ajuste local de cor |
| Correção de erros (LDPC no Wi-Fi 6 e no 5G) | o mesmo LDPC, com decisão suave |
| Detecção de erros (CRC dos pacotes) | CRC32 em cada bloco |
| Entrelaçamento | bits espalhados pelo quadro |
| Integridade | SHA-256 do arquivo inteiro |

**TCP × UDP.** O TCP garante a entrega pedindo reenvio do que se perdeu, e para isso precisa de um canal de volta. O UDP manda e esquece. Como o UDP, o Photon fala numa direção só, sem confirmação. Para não perder nada, ele soma **correção de erros antecipada** (fountain code), como em transmissões multicast e na TV digital. Na calibração, quem faz o papel de canal de volta é você, ao escolher o nível indicado.

O nome técnico da área é **comunicação por luz visível** (VLC). O Photon é um VLC de tela para câmera: parente do QR Code, só que contínuo e com correção de erros de nível 5G.

## Desenvolvimento

```sh
npm install
npm run dev     # https local (o Safari do iPhone exige https para a câmera)
npm test        # testes com câmera simulada (Node 24)
npm run build
```

Cada push no `main` roda os testes e publica no GitHub Pages.
