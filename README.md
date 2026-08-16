# Tibia Auto-Clicker (userscript)

Userscript para Tampermonkey/Violentmonkey (Chrome/Windows) que dispara um clique
**sintético** (botão esquerdo) a cada X minutos em um elemento definido por **seletor CSS**.
Continua funcionando com a aba em segundo plano / janela minimizada.

## Instalação

1. Instale a extensão **Tampermonkey** (ou Violentmonkey) no Chrome.
2. Abra o dashboard da extensão → **Create a new script**.
3. Cole o conteúdo de [`tibia-autoclicker.user.js`](tibia-autoclicker.user.js) e salve.
4. Edite o `@match` no topo com a URL do seu jogo (linha marcada `<-- TROQUE`).

## Uso rápido

1. Abra o jogo. O painel aparece no canto da tela.
2. Clique **Calibrar** (no Clique 1) ou tecle **Alt+C** e, em seguida, clique no elemento
   que você quer automatizar — o seletor CSS é capturado automaticamente.
3. Clique **Testar** para validar (o log mostra o elemento atingido, ex: `<button>`).
4. Ajuste o intervalo e ligue com o botão **Ligar** ou **Alt+K**.

### Atalhos

- **Alt+K** — liga/desliga.
- **Alt+C** — calibra o Clique 1 (captura o próximo clique real).
- **Alt+=** / **Alt+-** — aumenta/diminui o intervalo em 30s (mínimo 5s).

## Painel de ajustes

Painel flutuante (arrastável pelo cabeçalho, recolhível no botão `–`). Tudo é salvo com `GM_setValue`:

- **Cabeçalho:** bolinha verde/vermelha ON/OFF + botão **Ligar/Desligar**.
- **Intervalo:** slider + campo em segundos sincronizados, com contagem regressiva; e campo
  **Delay entre cliques** (ms).
- **Cliques da sequência:** até **4 cliques** por ciclo, cada um com caixa "usar" (ative só os
  que quiser — 1, 2 ou todos), campo de **seletor CSS** e botões **Calibrar** e **Testar** por clique.
  São disparados em ordem, com o delay entre eles.
- **Testar sequência**, **Log** (últimas ~10 linhas), **Salvar** e **Restaurar padrões**.

## Como funciona

- O clique é disparado como uma sequência completa de eventos sintéticos de **botão esquerdo**
  (`pointermove → mousedown → mouseup → click → pointerup`, com `button:0`/`buttons:1`,
  `clientX/clientY`, `screenX/screenY`, `bubbles:true`) **mais a chamada nativa `element.click()`**,
  que aciona de forma confiável o handler/ação padrão de elementos DOM.
- O **cronômetro** roda num **Web Worker** (Blob URL) para escapar do *throttling* de timers de
  background do Chrome; o disparo acontece na thread principal.
- Um `<audio>` em loop com um WAV de **amplitude mínima** (inaudível, mas não-zero) mantém a aba
  marcada como "tocando áudio", o que impede o Chrome de aplicar *throttling* nos timers em
  segundo plano. (Um áudio de ganho 0 **não** funciona: o Chrome o detecta como silêncio e não
  concede a isenção — por isso o WAV tem amostras não-zero.)

> ⚠️ Alguns clientes checam `event.isTrusted` e ignoram qualquer evento gerado por script.
> Nesse caso, nenhum userscript funciona — só automação em nível de navegador/SO. Se o **Testar**
> não acionar nada, é provavelmente esse o motivo.
>
> ⚠️ Use por sua conta e risco: automação pode violar os termos de serviço do jogo.
