// ==UserScript==
// @name         Tibia Auto-Clicker (CSS selector)
// @namespace    https://github.com/mrfeederr/auto-click
// @version      2.6.0
// @description  Auto-clique sintetico a cada X minutos por seletor CSS. Ate 4 cliques em sequencia com delay, funciona em background (Web Worker + audio silencioso), painel de ajustes didatico e calibracao.
// @author       you
// @match        https://baiakidle.com/*
// @match        https://baiakidle.com/jogar/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // Janela real da pagina (fora do sandbox do Tampermonkey), quando disponivel.
  // Usar a janela real como `view` deixa os eventos mais parecidos com os nativos.
  const PAGE_WIN = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  /* ============================================================================
   *  CONFIGURACAO  (mexa aqui em cima)
   *  ------------------------------------------------------------------------
   *  Voce NAO precisa editar o codigo: o painel na tela configura tudo e salva
   *  com GM_setValue. Os valores abaixo sao apenas os PADROES iniciais.
   * ==========================================================================*/

  // Um alvo de clique = um seletor CSS. Ate 4 sao disparados em sequencia.
  function defaultStep(enabled) {
    return { enabled: !!enabled, selector: '' };
  }

  const DEFAULTS = {
    // Intervalo entre CICLOS, em milissegundos (120000 ms = 2 minutos).
    intervalMs: 120000,

    // Delay ENTRE os cliques de uma mesma sequencia, em milissegundos.
    betweenClicksMs: 500,

    // Ate 4 cliques. Por padrao so o primeiro esta ativo.
    steps: [defaultStep(true), defaultStep(false), defaultStep(false), defaultStep(false)],
  };

  // ---- Constantes de comportamento (edite so se quiser) ---------------------
  const CONST = {
    MIN_INTERVAL_SEC: 5,
    MAX_INTERVAL_SEC: 600,
    STEP_MS: 30000,
    MAX_STEPS: 4,

    HOTKEY_TOGGLE: 'k',      // Alt+K  -> liga/desliga
    HOTKEY_CALIBRATE: 'c',   // Alt+C  -> calibra o clique 1
    HOTKEY_INC: '=',         // Alt+=  -> aumenta intervalo
    HOTKEY_DEC: '-',         // Alt+-  -> diminui intervalo

    START_ENABLED: false,

    STORE_SETTINGS: 'tibia_autoclick_settings',
    STORE_UI: 'tibia_autoclick_ui',
  };

  /* ============================================================================
   *  ESTADO INTERNO
   * ==========================================================================*/

  let settings = clone(DEFAULTS);
  let enabled = false;
  let calibrateTarget = null;   // indice do step em calibracao, ou null
  let nextClickAt = 0;
  let worker = null;
  const ui = {};
  ui.steps = [];
  const logLines = [];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ============================================================================
   *  PERSISTENCIA (GM_setValue com fallback para localStorage)
   * ==========================================================================*/

  function storageGet(key, def) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(key, undefined);
        return (v === undefined || v === null) ? def : v;
      }
    } catch (e) {}
    try {
      const v = localStorage.getItem(key);
      return v === null ? def : v;
    } catch (e) {}
    return def;
  }

  function storageSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
    } catch (e) {}
    try { localStorage.setItem(key, String(value)); } catch (e) {}
  }

  function loadSettings() {
    const raw = storageGet(CONST.STORE_SETTINGS, null);
    if (!raw) return;
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      settings = Object.assign(clone(DEFAULTS), obj);
      const steps = [];
      for (let i = 0; i < CONST.MAX_STEPS; i++) {
        const src = (obj.steps && obj.steps[i]) || {};
        steps[i] = {
          enabled: !!src.enabled,
          // migra config antiga: usa selector; se so tinha canvas, fica vazio.
          selector: typeof src.selector === 'string' ? src.selector : '',
        };
      }
      if (!obj.steps) steps[0].enabled = true;
      settings.steps = steps;
      settings.intervalMs = clampIntervalMs(settings.intervalMs);
      settings.betweenClicksMs = Math.max(0, Number(settings.betweenClicksMs) || 0);
    } catch (e) {
      console.warn('[AutoClick] Config salva invalida, usando padroes.', e);
      settings = clone(DEFAULTS);
    }
  }

  function saveSettings() { storageSet(CONST.STORE_SETTINGS, JSON.stringify(settings)); }

  function loadUiState() {
    const raw = storageGet(CONST.STORE_UI, null);
    if (!raw) return {};
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return {}; }
  }
  function saveUiState(state) { storageSet(CONST.STORE_UI, JSON.stringify(state)); }

  function clampIntervalMs(ms) {
    ms = Math.round(Number(ms) || DEFAULTS.intervalMs);
    return Math.max(CONST.MIN_INTERVAL_SEC * 1000, ms);
  }

  /* ============================================================================
   *  LOG (console + mini-area no painel)
   * ==========================================================================*/

  function ts() {
    const d = new Date();
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  function panelLog(msg) {
    const line = `[${ts().slice(0, 8)}] ${msg}`;
    logLines.push(line);
    while (logLines.length > 10) logLines.shift();
    if (ui.log) { ui.log.textContent = logLines.join('\n'); ui.log.scrollTop = ui.log.scrollHeight; }
    console.log(`%c[AutoClick ${ts()}]`, 'color:#4caf50;font-weight:bold', msg);
  }

  /* ============================================================================
   *  WEB WORKER (timer imune ao throttling de background)
   * ==========================================================================*/

  // O worker orquestra a SEQUENCIA INTEIRA (para tudo escapar do throttling de
  // background do Chrome): dispara cada clique espacado por betweenMs e, quando
  // a sequencia termina, espera intervalMs antes do proximo ciclo.
  //   start  -> comeca JA (primeiro ciclo imediato), depois conta o intervalo
  //   config -> aplica novos valores e reinicia a contagem (sem re-clicar na hora)
  // O worker e apenas o CRONOMETRO do ciclo: a cada disparo ele avisa a thread
  // principal ('tick'), e a thread principal roda a sequencia INTEIRA (mesma
  // funcao runSequence usada pelo botao "Testar sequencia"). O gap entre ticks =
  // duracao da sequencia + intervalo, para o intervalo contar apos o loop terminar.
  const WORKER_SRC = `
    let intervalMs = 120000, betweenMs = 500, count = 1, running = false, timer = null;
    function gap() { return (count > 0 ? count - 1 : 0) * betweenMs + intervalMs; }
    function tick() {
      if (!running) return;
      postMessage({ type: 'tick' });
      timer = setTimeout(tick, gap());
    }
    onmessage = function (e) {
      const m = e.data || {};
      if (m.type === 'start') {
        intervalMs = m.intervalMs; betweenMs = m.betweenMs; count = m.count;
        running = true; clearTimeout(timer); tick();     // primeiro loop IMEDIATO
      } else if (m.type === 'stop') {
        running = false; clearTimeout(timer);
      } else if (m.type === 'config') {
        intervalMs = m.intervalMs; betweenMs = m.betweenMs; count = m.count;
        if (running) { clearTimeout(timer); timer = setTimeout(tick, intervalMs); } // reinicia a contagem
      }
    };
  `;

  // Lista dos cliques ativos, com o indice original de cada um.
  function activeStepList() {
    const a = [];
    settings.steps.forEach((s, i) => { if (s.enabled) a.push({ s, i }); });
    return a;
  }
  function seqConfig() {
    return {
      intervalMs: settings.intervalMs,
      betweenMs: Math.max(0, Number(settings.betweenClicksMs) || 0),
      count: activeStepList().length,
    };
  }

  function createWorker() {
    if (worker) return;
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = function (e) {
      const d = e.data || {};
      if (d.type === 'tick') {
        const cfg = seqConfig();
        nextClickAt = Date.now() + Math.max(0, cfg.count - 1) * cfg.betweenMs + cfg.intervalMs;
        runSequence(false); // roda a sequencia inteira na thread principal
      }
    };
  }
  function workerStart() {
    createWorker();
    const cfg = seqConfig();
    // Countdown otimista ate a mensagem 'cycle' chegar do worker.
    nextClickAt = Date.now() + Math.max(0, cfg.count - 1) * cfg.betweenMs + cfg.intervalMs;
    worker.postMessage(Object.assign({ type: 'start' }, cfg));
  }
  function workerStop() { if (worker) worker.postMessage({ type: 'stop' }); nextClickAt = 0; }
  // Aplica no worker mudancas de intervalo/delay/quantidade de cliques (se ligado).
  function pushSeqConfig() {
    if (worker && enabled) {
      worker.postMessage(Object.assign({ type: 'config' }, seqConfig()));
      nextClickAt = Date.now() + seqConfig().intervalMs; // countdown reinicia
    }
  }

  /* ============================================================================
   *  RESOLUCAO DO ALVO E DISPARO DO CLIQUE (botao ESQUERDO)
   * ==========================================================================*/

  // Retorna { el, clientX, clientY } para o step, ou null.
  function resolveStepTarget(step) {
    const sel = (step.selector || '').trim();
    if (!sel) { panelLog('ERRO: seletor vazio. Calibre ou digite um seletor.'); return null; }
    let el;
    try { el = document.querySelector(sel); }
    catch (e) { panelLog('ERRO: seletor invalido (' + sel + ')'); return null; }
    if (!el) { panelLog('ERRO: alvo nao encontrado (' + sel + ')'); return null; }
    const r = el.getBoundingClientRect();
    return { el, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  }

  function screenXY(x, y) {
    return { sx: x + (window.screenX || 0), sy: y + (window.screenY || 0) };
  }

  // Cada clique usa um pointerId DIFERENTE. Reusar o mesmo id faz o jogo, se
  // tiver capturado o ponteiro no clique anterior (setPointerCapture), redirecionar
  // os eventos do clique seguinte para o elemento errado -> so o 1o clique funciona.
  let pointerSeq = 1;

  // Todos os eventos usam o botao ESQUERDO: button:0 e buttons:1 enquanto pressionado.
  function firePointerEvent(el, type, x, y, pressure, pid) {
    if (typeof PointerEvent !== 'function') return;
    const { sx, sy } = screenXY(x, y);
    const down = (type === 'pointerdown');
    const up = (type === 'pointerup');
    try {
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, view: PAGE_WIN,
        pointerId: pid, pointerType: 'mouse', isPrimary: true,
        width: 1, height: 1, pressure: pressure != null ? pressure : (down ? 0.5 : 0),
        button: (down || up) ? 0 : -1,   // 0 = esquerdo; -1 = nenhum (para move)
        buttons: down ? 1 : 0,           // 1 = esquerdo pressionado
        clientX: x, clientY: y, screenX: sx, screenY: sy,
      }));
    } catch (e) {}
  }
  function fireMouseEvent(el, type, x, y) {
    const { sx, sy } = screenXY(x, y);
    const down = (type === 'mousedown');
    try {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true, view: PAGE_WIN,
        button: 0,                        // 0 = botao esquerdo
        buttons: down ? 1 : 0,
        clientX: x, clientY: y, screenX: sx, screenY: sy,
        detail: type === 'click' ? 1 : 0,
      }));
    } catch (e) {}
  }

  // Dispara UM clique (esquerdo) sintetico completo no elemento do step.
  function clickStep(step, label) {
    const t = resolveStepTarget(step);
    if (!t) return false;
    const { el, clientX, clientY } = t;
    const pid = ++pointerSeq; // pointerId unico para este clique

    if (el.disabled) { panelLog(`${label} ignorado: elemento desabilitado`); return false; }

    // Libera qualquer captura de ponteiro remanescente do clique anterior.
    try { if (el.hasPointerCapture && el.hasPointerCapture(pid)) el.releasePointerCapture(pid); } catch (e) {}
    // NAO chamamos focus(): para botoes DOM o el.click() nao precisa de foco, e
    // focar a janela/um elemento fora de um dialogo pode FECHAR o dialogo
    // (muitos fecham no blur) -- era o que fechava a "janela do 2o clique".

    // Hover + press (para engines que precisam do down/up). NAO disparamos um
    // evento 'click' sintetico aqui: a ativacao vem do el.click() nativo abaixo.
    // Antes disparavamos os dois -> o botao era acionado DUAS vezes por ciclo,
    // o que em janelas/dialogos abria e ja fechava ("a janela do 2o clique fecha").
    firePointerEvent(el, 'pointerover', clientX, clientY, 0, pid);
    fireMouseEvent(el, 'mouseover', clientX, clientY);
    firePointerEvent(el, 'pointermove', clientX, clientY, 0, pid);
    fireMouseEvent(el, 'mousemove', clientX, clientY);
    firePointerEvent(el, 'pointerdown', clientX, clientY, 0.5, pid);
    fireMouseEvent(el, 'mousedown', clientX, clientY);
    firePointerEvent(el, 'pointerup', clientX, clientY, 0, pid);
    fireMouseEvent(el, 'mouseup', clientX, clientY);

    // Ativacao UNICA e confiavel (dispara onClick de handlers DOM/React e a acao
    // padrao do elemento). Um unico acionamento por ciclo.
    try { el.click(); } catch (e) {}

    const tag = el.tagName ? el.tagName.toLowerCase() : '?';
    const selShort = (step.selector || '').slice(0, 40);
    // Diagnostico: [act:A] = ha "user activation" (gesto recente); [act:-] = nao ha.
    // Se so funciona com act:A, o jogo exige gesto do usuario (nao ha como um
    // userscript falsificar isso com evento sintetico).
    let act = '?';
    try { if (navigator.userActivation) act = navigator.userActivation.isActive ? 'A' : '-'; } catch (e) {}
    panelLog(`${label} <${tag}> [act:${act}] (${Math.round(clientX)},${Math.round(clientY)}) « ${selShort}`);
    return true;
  }

  // Dispara a sequencia de cliques ativos, com delay entre eles (usado nos
  // testes manuais, em foreground). Quando LIGADO, quem orquestra e o worker.
  function runSequence(manual) {
    const active = activeStepList();
    if (!active.length) { panelLog('Nenhum clique ativo.'); return; }
    let k = 0;
    (function next() {
      if (k >= active.length) return;
      const { s, i } = active[k++];
      clickStep(s, (manual ? 'TESTE ' : '') + `[C${i + 1}]`);
      if (k < active.length) setTimeout(next, Math.max(0, Number(settings.betweenClicksMs) || 0));
    })();
  }

  /* ============================================================================
   *  CALIBRACAO (por clique/step) -> captura o seletor do proximo clique real
   * ==========================================================================*/

  function armCalibration(stepIndex) {
    calibrateTarget = stepIndex;
    panelLog(`Calibracao do clique ${stepIndex + 1}: clique no elemento-alvo agora.`);
    const st = ui.steps[stepIndex];
    if (st) { st.calBtn.textContent = 'Clique no alvo...'; st.calBtn.style.background = '#ff9800'; st.calBtn.style.color = '#000'; }
  }
  function resetCalButton(i) {
    const st = ui.steps[i];
    if (st) { st.calBtn.textContent = 'Calibrar'; st.calBtn.style.background = ''; st.calBtn.style.color = ''; }
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let sel = node.nodeName.toLowerCase();
      if (node.classList && node.classList.length) {
        sel += '.' + Array.from(node.classList).map((c) => CSS.escape(c)).join('.');
      }
      let nth = 1, sib = node;
      while ((sib = sib.previousElementSibling)) { if (sib.nodeName === node.nodeName) nth++; }
      sel += `:nth-of-type(${nth})`;
      parts.unshift(sel);
      if (node.id) { parts[0] = `#${CSS.escape(node.id)}`; break; }
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function onRealClickCapture(e) {
    if (calibrateTarget === null) return;
    if (ui.box && ui.box.contains(e.target)) return; // ignora cliques no painel
    const idx = calibrateTarget;
    calibrateTarget = null;
    resetCalButton(idx);

    const selector = cssPath(e.target);
    settings.steps[idx].selector = selector;
    saveSettings();
    syncStepInputs(idx);

    console.log(`%c[AutoClick CALIBRACAO C${idx + 1} ${ts()}]`, 'color:#ff9800;font-weight:bold',
      '\n  selector :', selector, '\n  elemento :', e.target);
    panelLog(`Clique ${idx + 1} calibrado: ${selector}`);
  }

  /* ============================================================================
   *  LIGA / DESLIGA
   * ==========================================================================*/

  function enable() {
    if (enabled) return;
    enabled = true;
    workerStart();
    const cfg = seqConfig();
    panelLog(`LIGADO | ${cfg.count} clique(s) | delay ${cfg.betweenMs}ms | ciclo ${cfg.intervalMs / 1000}s`);
    updateHeader();
  }
  function disable() {
    if (!enabled) return;
    enabled = false;
    workerStop();
    panelLog('DESLIGADO');
    updateHeader();
  }
  function toggle() { enabled ? disable() : enable(); }

  /* ============================================================================
   *  AJUSTE DE INTERVALO
   * ==========================================================================*/

  function applyIntervalMs(newMs) {
    settings.intervalMs = clampIntervalMs(newMs);
    saveSettings();
    pushSeqConfig();   // reinicia a contagem no worker com o novo valor
    syncIntervalUI();
  }
  function incInterval() { applyIntervalMs(settings.intervalMs + CONST.STEP_MS); }
  function decInterval() { applyIntervalMs(settings.intervalMs - CONST.STEP_MS); }

  /* ============================================================================
   *  PAINEL DE AJUSTES
   * ==========================================================================*/

  const PANEL_CSS = `
    #ac-panel{position:fixed;z-index:2147483647;top:12px;right:12px;width:280px;
      background:rgba(22,24,29,0.93);color:#e6e6e6;font:12px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;
      border:1px solid #3a3f47;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.5);
      user-select:none;backdrop-filter:blur(2px)}
    #ac-panel *{box-sizing:border-box}
    #ac-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;border-bottom:1px solid #3a3f47}
    #ac-dot{width:11px;height:11px;border-radius:50%;background:#f44336;flex:0 0 auto;box-shadow:0 0 6px rgba(0,0,0,0.4)}
    #ac-title{font-weight:700;flex:1 1 auto}
    #ac-power{cursor:pointer;border:0;border-radius:6px;padding:3px 10px;font-weight:600;color:#fff;background:#2e7d32}
    #ac-min{cursor:pointer;border:0;background:transparent;color:#9aa0a8;font-size:16px;line-height:1;padding:0 2px}
    #ac-body{padding:10px;max-height:78vh;overflow:auto}
    .ac-sec{margin-bottom:12px}
    .ac-sec h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8b93a1}
    .ac-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
    .ac-lbl{color:#b9c0ca;flex:0 0 auto}
    #ac-panel input[type=text],#ac-panel input[type=number]{
      background:#14161b;color:#e6e6e6;border:1px solid #454b55;border-radius:5px;padding:3px 6px;font:inherit;width:100%}
    #ac-panel input[type=number]{width:64px}
    #ac-slider{flex:1 1 auto}
    .ac-hint{color:#7f8894;font-size:10px;margin-top:2px}
    .ac-btn{cursor:pointer;border:1px solid #454b55;background:#2b2f36;color:#e6e6e6;border-radius:6px;padding:4px 8px;font:inherit}
    .ac-btn:hover{background:#353a42}
    .ac-btn.primary{background:#2e7d32;border-color:#2e7d32;color:#fff}
    .ac-btn.sm{padding:2px 7px;font-size:11px}
    #ac-count{font-weight:700;color:#7fd1ff}
    .ac-step{border:1px solid #333842;border-radius:8px;padding:7px 8px;margin-bottom:7px;background:rgba(255,255,255,0.02)}
    .ac-step.off{opacity:.55}
    .ac-step-head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
    .ac-step-head label{display:flex;align-items:center;gap:5px;font-weight:600;flex:1 1 auto;cursor:pointer}
    #ac-log{background:#0f1114;border:1px solid #2c313a;border-radius:6px;height:92px;overflow:auto;padding:5px 7px;
      font:10px/1.4 monospace;color:#9fe0a5;white-space:pre-wrap;word-break:break-word;
      user-select:text;-webkit-user-select:text;cursor:text}
    .ac-sec-head{display:flex;align-items:center;justify-content:space-between;margin:0 0 6px}
    .ac-sec-head h4{margin:0}
    .ac-foot{display:flex;gap:6px;margin-top:8px}
    .ac-foot .ac-btn{flex:1 1 auto}
    #ac-kbd{color:#6b7280;font-size:10px;margin-top:8px}
  `;

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);

    const box = document.createElement('div');
    box.id = 'ac-panel';
    box.innerHTML = `
      <div id="ac-head" title="Arraste para mover o painel">
        <span id="ac-dot"></span>
        <span id="ac-title">Auto-Click</span>
        <button id="ac-power" title="Ligar/Desligar (Alt+K)">Ligar</button>
        <button id="ac-min" title="Recolher/expandir o painel">–</button>
      </div>
      <div id="ac-body">

        <div class="ac-sec">
          <h4>Intervalo entre ciclos</h4>
          <div class="ac-row">
            <input id="ac-slider" type="range" min="${CONST.MIN_INTERVAL_SEC}" max="${CONST.MAX_INTERVAL_SEC}" step="1"
                   title="Arraste para ajustar o intervalo (segundos)">
            <input id="ac-secs" type="number" min="${CONST.MIN_INTERVAL_SEC}" step="1"
                   title="Digite o intervalo em segundos e tecle Enter">
            <span class="ac-lbl">s</span>
          </div>
          <div class="ac-row">
            <span class="ac-lbl" style="flex:1 1 auto">Delay entre cliques</span>
            <input id="ac-between" type="number" min="0" step="50" title="Espera entre cliques da sequencia (ms)">
            <span class="ac-lbl">ms</span>
          </div>
          <div class="ac-hint">Proximo ciclo em: <span id="ac-count">--</span></div>
        </div>

        <div class="ac-sec">
          <h4>Cliques da sequencia (seletor CSS)</h4>
          <div id="ac-steps"></div>
          <div class="ac-hint">Marque quais cliques usar (1 a ${CONST.MAX_STEPS}). Use "Calibrar" e clique no elemento do jogo para capturar o seletor.</div>
        </div>

        <div class="ac-sec">
          <div class="ac-sec-head">
            <h4>Log (ultimos disparos)</h4>
            <button id="ac-copylog" class="ac-btn sm" title="Copia o log para a area de transferencia">Copiar log</button>
          </div>
          <div id="ac-log"></div>
        </div>

        <div class="ac-foot">
          <button id="ac-runall" class="ac-btn" title="Dispara a sequencia inteira agora">Testar sequencia</button>
          <button id="ac-save" class="ac-btn primary" title="Salva a configuracao">Salvar</button>
          <button id="ac-reset" class="ac-btn" title="Volta tudo para o padrao">Padroes</button>
        </div>
        <div id="ac-kbd">Alt+K liga/desliga &middot; Alt+= / Alt+- ±30s &middot; Alt+C calibra o clique 1</div>
      </div>
    `;

    (document.body || document.documentElement).appendChild(box);

    ui.box = box;
    ui.body = box.querySelector('#ac-body');
    ui.dot = box.querySelector('#ac-dot');
    ui.power = box.querySelector('#ac-power');
    ui.minBtn = box.querySelector('#ac-min');
    ui.slider = box.querySelector('#ac-slider');
    ui.secs = box.querySelector('#ac-secs');
    ui.between = box.querySelector('#ac-between');
    ui.count = box.querySelector('#ac-count');
    ui.stepsWrap = box.querySelector('#ac-steps');
    ui.log = box.querySelector('#ac-log');

    buildSteps();
    wirePanel(box);
    restoreUiLayout();
    syncIntervalUI();
    updateHeader();
  }

  function buildSteps() {
    ui.steps = [];
    for (let i = 0; i < CONST.MAX_STEPS; i++) {
      const block = el(`
        <div class="ac-step">
          <div class="ac-step-head">
            <label title="Ative para incluir este clique na sequencia">
              <input type="checkbox" class="ac-en"> Clique ${i + 1}
            </label>
            <button class="ac-btn sm ac-cal" title="Clique aqui e depois no elemento do jogo para capturar o seletor">Calibrar</button>
            <button class="ac-btn sm ac-test" title="Dispara so este clique agora">Testar</button>
          </div>
          <div class="ac-row">
            <span class="ac-lbl" style="width:52px">Seletor</span>
            <input type="text" class="ac-sel" placeholder="ex: #botao ou .classe" title="Seletor CSS do elemento que recebe o clique">
          </div>
        </div>
      `);

      const refs = {
        block,
        en: block.querySelector('.ac-en'),
        calBtn: block.querySelector('.ac-cal'),
        testBtn: block.querySelector('.ac-test'),
        sel: block.querySelector('.ac-sel'),
      };

      const idx = i;
      refs.en.addEventListener('change', () => { settings.steps[idx].enabled = refs.en.checked; saveSettings(); updateStepVisual(idx); pushSeqConfig(); });
      refs.sel.addEventListener('change', () => { settings.steps[idx].selector = refs.sel.value.trim(); saveSettings(); });
      refs.calBtn.addEventListener('click', () => armCalibration(idx));
      refs.testBtn.addEventListener('click', () => clickStep(settings.steps[idx], `TESTE [C${idx + 1}]`));

      ui.steps.push(refs);
      ui.stepsWrap.appendChild(block);
      syncStepInputs(idx);
    }
  }

  function wirePanel(box) {
    ui.power.addEventListener('click', toggle);
    ui.minBtn.addEventListener('click', () => toggleCollapse());

    ui.slider.addEventListener('input', () => applyIntervalMs(Number(ui.slider.value) * 1000));
    ui.secs.addEventListener('change', () => applyIntervalMs(Number(ui.secs.value) * 1000));
    ui.secs.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyIntervalMs(Number(ui.secs.value) * 1000); });
    ui.between.addEventListener('change', () => { settings.betweenClicksMs = Math.max(0, Number(ui.between.value) || 0); saveSettings(); pushSeqConfig(); });

    box.querySelector('#ac-runall').addEventListener('click', () => runSequence(true));

    const copyBtn = box.querySelector('#ac-copylog');
    copyBtn.addEventListener('click', () => {
      const text = logLines.join('\n');
      const done = () => { const o = copyBtn.textContent; copyBtn.textContent = 'Copiado ✓'; setTimeout(() => { copyBtn.textContent = o; }, 1200); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); }
        else fallbackCopy(text, done);
      } catch (e) { fallbackCopy(text, done); }
    });
    function fallbackCopy(text, done) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
    ui.saveBtn = box.querySelector('#ac-save');
    ui.saveBtn.addEventListener('click', () => {
      saveSettings();
      const old = ui.saveBtn.textContent;
      ui.saveBtn.textContent = 'Salvo ✓';
      setTimeout(() => { ui.saveBtn.textContent = old; }, 1200);
      panelLog('Configuracao salva.');
    });
    box.querySelector('#ac-reset').addEventListener('click', () => {
      settings = clone(DEFAULTS);
      saveSettings();
      for (let i = 0; i < CONST.MAX_STEPS; i++) syncStepInputs(i);
      applyIntervalMs(settings.intervalMs);
      panelLog('Padroes restaurados.');
    });

    makeDraggable(box, box.querySelector('#ac-head'));
  }

  function syncStepInputs(i) {
    const st = ui.steps[i]; const s = settings.steps[i];
    if (!st) return;
    st.en.checked = s.enabled;
    st.sel.value = s.selector;
    updateStepVisual(i);
  }
  function updateStepVisual(i) {
    const st = ui.steps[i];
    if (st) st.block.classList.toggle('off', !settings.steps[i].enabled);
  }

  function syncIntervalUI() {
    if (!ui.slider) return;
    const secs = settings.intervalMs / 1000;
    ui.slider.value = Math.min(CONST.MAX_INTERVAL_SEC, Math.max(CONST.MIN_INTERVAL_SEC, secs));
    if (document.activeElement !== ui.secs) ui.secs.value = secs;
    if (document.activeElement !== ui.between) ui.between.value = settings.betweenClicksMs;
    refreshCountdown();
  }

  function updateHeader() {
    if (!ui.dot) return;
    ui.dot.style.background = enabled ? '#4caf50' : '#f44336';
    ui.dot.title = enabled ? 'Ligado' : 'Desligado';
    ui.power.textContent = enabled ? 'Desligar' : 'Ligar';
    ui.power.style.background = enabled ? '#b23b3b' : '#2e7d32';
    refreshCountdown();
  }

  function refreshCountdown() {
    if (!ui.count) return;
    if (!enabled || !nextClickAt) { ui.count.textContent = '--'; return; }
    const s = Math.ceil(Math.max(0, nextClickAt - Date.now()) / 1000);
    ui.count.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  setInterval(refreshCountdown, 1000);

  function toggleCollapse(force) {
    const collapse = typeof force === 'boolean' ? force : ui.body.style.display !== 'none';
    ui.body.style.display = collapse ? 'none' : '';
    ui.minBtn.textContent = collapse ? '+' : '–';
    persistUiLayout();
  }

  function makeDraggable(box, handle) {
    let dragging = false, offX = 0, offY = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const r = box.getBoundingClientRect();
      offX = e.clientX - r.left; offY = e.clientY - r.top;
      box.style.right = 'auto'; box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const left = Math.max(0, Math.min(window.innerWidth - box.offsetWidth, e.clientX - offX));
      const top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - offY));
      box.style.left = left + 'px'; box.style.top = top + 'px';
    });
    handle.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
      persistUiLayout();
    });
  }

  function persistUiLayout() {
    const r = ui.box.getBoundingClientRect();
    saveUiState({ left: r.left, top: r.top, collapsed: ui.body.style.display === 'none' });
  }
  function restoreUiLayout() {
    const st = loadUiState();
    if (st && typeof st.left === 'number') {
      ui.box.style.right = 'auto';
      ui.box.style.left = Math.max(0, Math.min(window.innerWidth - 60, st.left)) + 'px';
      ui.box.style.top = Math.max(0, Math.min(window.innerHeight - 30, st.top || 12)) + 'px';
    }
    if (st && st.collapsed) toggleCollapse(true);
  }

  /* ============================================================================
   *  ATALHOS DE TECLADO
   * ==========================================================================*/

  function onKeyDown(e) {
    if (!e.altKey) return;
    if (ui.box && ui.box.contains(e.target)) return;
    const key = (e.key || '').toLowerCase();
    if (key === CONST.HOTKEY_TOGGLE) { e.preventDefault(); toggle(); }
    else if (key === CONST.HOTKEY_CALIBRATE) { e.preventDefault(); armCalibration(0); }
    else if (e.key === CONST.HOTKEY_INC || key === CONST.HOTKEY_INC) { e.preventDefault(); incInterval(); }
    else if (e.key === CONST.HOTKEY_DEC || key === CONST.HOTKEY_DEC) { e.preventDefault(); decInterval(); }
  }

  /* ============================================================================
   *  INICIALIZACAO
   * ==========================================================================*/

  function init() {
    loadSettings();
    buildPanel();
    window.addEventListener('click', onRealClickCapture, true);
    window.addEventListener('keydown', onKeyDown, true);
    panelLog('Pronto. Intervalo ' + (settings.intervalMs / 1000) + 's.');
    if (CONST.START_ENABLED) enable();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
