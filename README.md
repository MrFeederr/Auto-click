# Tibia Auto-Clicker (userscript)

Userscript para Tampermonkey/Violentmonkey (Chrome/Windows) que dispara um clique
**sintético** a cada X minutos em um jogo de navegador rodando em `<canvas>` (ex: Tibia).
Continua funcionando com a aba em segundo plano / janela minimizada.

## Instalação

1. Instale a extensão **Tampermonkey** (ou Violentmonkey) no Chrome.
2. Abra o dashboard da extensão → **Create a new script**.
3. Cole o conteúdo de [`tibia-autoclicker.user.js`](tibia-autoclicker.user.js) e salve.
4. Edite o `@match` no topo com a URL do seu jogo (linha marcada `<-- TROQUE`).

## Uso rápido

- **Alt+K** — liga/desliga o auto-clique (estado aparece no console e no painel).
- **Alt+C** — arma a calibração: o **próximo clique real** seu na tela é capturado e
  o console mostra o `selector` do elemento e as coordenadas x/y relativas ao canvas.
  Copie esses valores para `CONFIG.CANVAS_X` / `CONFIG.CANVAS_Y` (ou `TARGET_SELECTOR`).
- **Alt+=** / **Alt+-** — aumenta/diminui o intervalo em 30s (mínimo 5s).
- Painel flutuante (canto inferior direito): mostra estado (ON/OFF), intervalo atual e
  contagem regressiva; tem campo para digitar novo intervalo (em segundos) e aplicar na hora.

## Configuração (topo do script)

Todas as variáveis ficam no objeto `CONFIG` no topo do arquivo, comentadas:

- `DEFAULT_INTERVAL_MS` — intervalo padrão (default `120000` = 2 min). Fica **salvo** entre sessões.
- `MIN_INTERVAL_MS` — intervalo mínimo (default `5000`).
- `STEP_MS` — passo dos atalhos Alt+= / Alt+- (default `30000`).
- `TARGET_MODE` — `'canvas'` (coordenadas x/y no canvas) ou `'selector'` (CSS selector).
- `CANVAS_SELECTOR`, `CANVAS_X`, `CANVAS_Y` — alvo no modo canvas.
- `TARGET_SELECTOR` — alvo no modo selector.

## Como funciona em background

- O **cronômetro** roda dentro de um **Web Worker** (criado via Blob URL) para escapar do
  *throttling* de timers de background do Chrome. O worker só avisa a thread principal;
  o disparo do clique acontece na thread principal.
- Um **áudio silencioso** (WebAudio, ganho 0) toca em loop para impedir que o Chrome
  congele/descarte a aba em background.

O clique é uma sequência completa de eventos sintéticos disparados direto no elemento:
`pointerdown → mousedown → mouseup → click → pointerup`, com `clientX/clientY`, `bubbles:true`
e `button:0`. Nenhum movimento de mouse físico é usado.

> ⚠️ Use por sua conta e risco: automação pode violar os termos de serviço do jogo.
