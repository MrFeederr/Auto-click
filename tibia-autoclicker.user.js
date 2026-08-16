// ==UserScript==
// @name         Tibia Auto-Clicker (canvas)
// @namespace    https://github.com/mrfeederr/auto-click
// @version      1.1.0
// @description  Auto-clique sintetico a cada X minutos em jogo de navegador (canvas), funciona em background com Web Worker + audio silencioso. Painel de ajustes didatico, calibracao e atalhos.
// @author       you
// @match        https://*.tibia.com/*
// @match        https://SEU-JOGO-AQUI/*            // <-- TROQUE pela URL do jogo (pode repetir @match)
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================================
   *  CONFIGURACAO  (mexa aqui em cima)
   *  ------------------------------------------------------------------------
   *  Voce NAO precisa editar o codigo para usar: o painel de ajustes na tela
   *  permite configurar tudo e salva com GM_setValue. Os valores abaixo sao
   *  apenas os PADROES iniciais (usados na primeira vez e no "Restaurar padroes").
   * ==========================================================================*/

  // ---- Padroes editaveis (tambem ajustaveis pela UI e persistidos) ----------
  const DEFAULTS = {
    // Intervalo entre cliques, em milissegundos (120000 ms = 2 minutos).
    intervalMs: 120000,

    // Alvo do clique. Dois modos:
    //   'canvas'   -> clica em coordenadas x/y RELATIVAS ao canvas do jogo
    //   'selector' -> clica no elemento apontado por um seletor CSS
    targetMode: 'canvas',

    // Modo 'canvas': seletor do canvas e coordenadas relativas ao seu canto
    // superior-esquerdo (em pixels de tela). Use "Calibrar" para descobrir.
    canvasSelector: 'canvas',
    canvasX: 400,
    canvasY: 300,

    // Modo 'selector': seletor CSS do elemento que recebe o clique.
    targetSelector: 'canvas',
  };

  // ---- Constantes de comportamento (edite so se quiser) ---------------------
  const CONST = {
    MIN_INTERVAL_SEC: 5,     // intervalo minimo (nao deixa "zerar")
    MAX_INTERVAL_SEC: 600,   // maximo do slider (10 min); o campo aceita mais
    STEP_MS: 30000,          // passo dos atalhos Alt+= / Alt+- (30 s)

    // Atalhos (sempre combinados com Alt)
    HOTKEY_TOGGLE: 'k',      // Alt+K  -> liga/desliga
    HOTKEY_CALIBRATE: 'c',   // Alt+C  -> arma calibracao (proximo clique real)
    HOTKEY_INC: '=',         // Alt+=  -> aumenta intervalo em STEP_MS
    HOTKEY_DEC: '-',         // Alt+-  -> diminui intervalo em STEP_MS

    START_ENABLED: false,    // comeca desligado; ligue com Alt+K ou pelo painel

    // Chaves de armazenamento (GM_setValue / localStorage)
    STORE_SETTINGS: 'tibia_autoclick_settings', // config (JSON)
    STORE_UI: 'tibia_autoclick_ui',             // posicao/estado do painel (JSON)
  };

  /* ============================================================================
   *  ESTADO INTERNO
   * ==========================================================================*/

  let settings = Object.assign({}, DEFAULTS); // config corrente (usada nos cliques)
  let enabled = false;         // auto-clique ligado?
  let calibrating = false;     // esperando o proximo clique real do usuario?
  let nextClickAt = 0;         // timestamp (ms) do proximo clique agendado
  let worker = null;           // Web Worker que "bate" o tempo em background
  let audioCtx = null;         // contexto WebAudio do keep-alive
  const ui = {};               // referencias aos elementos do painel
  const logLines = [];         // ultimas linhas da mini-area de log

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

  // Le/grava a config inteira como JSON.
  function loadSettings() {
    let raw = storageGet(CONST.STORE_SETTINGS, null);
    if (!raw) return;
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      settings = Object.assign({}, DEFAULTS, obj); // mescla com os padroes
      settings.intervalMs = clampIntervalMs(settings.intervalMs);
    } catch (e) {
      console.warn('[AutoClick] Config salva invalida, usando padroes.', e);
    }
  }

  function saveSettings() {
    storageSet(CONST.STORE_SETTINGS, JSON.stringify(settings));
  }

  // Estado visual do painel (posicao e se esta recolhido).
  function loadUiState() {
    const raw = storageGet(CONST.STORE_UI, null);
    if (!raw) return {};
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return {}; }
  }
  function saveUiState(state) {
    storageSet(CONST.STORE_UI, JSON.stringify(state));
  }

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

  // Log rico no console (aceita objetos/elementos).
  function log(...args) {
    console.log(`%c[AutoClick ${ts()}]`, 'color:#4caf50;font-weight:bold', ...args);
  }

  // Log de texto simples que aparece TAMBEM na mini-area do painel.
  function panelLog(msg) {
    const line = `[${ts().slice(0, 8)}] ${msg}`;
    logLines.push(line);
    while (logLines.length > 10) logLines.shift(); // mantem so as ultimas ~10
    if (ui.log) {
      ui.log.textContent = logLines.join('\n');
      ui.log.scrollTop = ui.log.scrollHeight;
    }
    console.log(`%c[AutoClick ${ts()}]`, 'color:#4caf50;font-weight:bold', msg);
  }

  /* ============================================================================
   *  KEEP-ALIVE DE AUDIO
   *  Um audio silencioso em loop impede o Chrome de congelar/descartar a aba
   *  quando ela vai para segundo plano.
   * ==========================================================================*/

  function startAudioKeepAlive() {
    if (audioCtx) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0;            // ganho 0 = totalmente silencioso
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      // Alguns navegadores suspendem o contexto ate uma interacao do usuario.
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch (e) {
      console.warn('[AutoClick] Nao foi possivel iniciar o keep-alive de audio:', e);
    }
  }

  function stopAudioKeepAlive() {
    if (!audioCtx) return;
    try { audioCtx.close(); } catch (e) {}
    audioCtx = null;
  }

  /* ============================================================================
   *  WEB WORKER (timer imune ao throttling de background)
   *  Timers na thread principal sao estrangulados pelo Chrome quando a aba
   *  esta em background. Rodando o cronometro dentro de um Worker escapamos
   *  disso. O Worker apenas AVISA; o clique acontece na thread principal.
   * ==========================================================================*/

  const WORKER_SRC = `
    let intervalMs = 120000;
    let timer = null;
    function fire() {
      postMessage({ type: 'tick' });
      schedule();
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(fire, intervalMs);
    }
    onmessage = function (e) {
      const msg = e.data || {};
      if (msg.type === 'start') {
        intervalMs = msg.intervalMs;
        schedule();
      } else if (msg.type === 'stop') {
        clearTimeout(timer);
        timer = null;
      } else if (msg.type === 'setInterval') {
        intervalMs = msg.intervalMs;
        // Reinicia a contagem ja com o novo valor (se estiver rodando).
        if (timer !== null) schedule();
      }
    };
  `;

  function createWorker() {
    if (worker) return;
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    URL.revokeObjectURL(url); // o worker ja foi criado; podemos liberar a URL
    worker.onmessage = function (e) {
      if (e.data && e.data.type === 'tick') {
        doClick();
        nextClickAt = Date.now() + settings.intervalMs; // agenda o proximo
      }
    };
  }

  function workerStart() {
    createWorker();
    nextClickAt = Date.now() + settings.intervalMs;
    worker.postMessage({ type: 'start', intervalMs: settings.intervalMs });
  }

  function workerStop() {
    if (worker) worker.postMessage({ type: 'stop' });
    nextClickAt = 0;
  }

  function workerSetInterval() {
    if (worker) worker.postMessage({ type: 'setInterval', intervalMs: settings.intervalMs });
    // Se ligado, reinicia a contagem regressiva visual tambem.
    if (enabled) nextClickAt = Date.now() + settings.intervalMs;
  }

  /* ============================================================================
   *  RESOLUCAO DO ALVO E DAS COORDENADAS DO CLIQUE
   * ==========================================================================*/

  // Retorna { el, clientX, clientY } de acordo com settings.targetMode, ou null.
  function resolveTarget() {
    if (settings.targetMode === 'canvas') {
      const canvas = document.querySelector(settings.canvasSelector);
      if (!canvas) {
        panelLog('ERRO: canvas nao encontrado (' + settings.canvasSelector + ')');
        return null;
      }
      const r = canvas.getBoundingClientRect();
      // Coordenadas relativas ao canvas -> clientX/clientY corretos na tela.
      const clientX = r.left + Number(settings.canvasX);
      const clientY = r.top + Number(settings.canvasY);
      // O elemento sob esse ponto (pode ser o canvas ou um overlay).
      const el = document.elementFromPoint(clientX, clientY) || canvas;
      return { el, clientX, clientY };
    }

    // Modo 'selector'
    const el = document.querySelector(settings.targetSelector);
    if (!el) {
      panelLog('ERRO: alvo nao encontrado (' + settings.targetSelector + ')');
      return null;
    }
    const r = el.getBoundingClientRect();
    // Clica no centro do elemento.
    const clientX = r.left + r.width / 2;
    const clientY = r.top + r.height / 2;
    return { el, clientX, clientY };
  }

  /* ============================================================================
   *  DISPARO DO CLIQUE SINTETICO
   *  Sequencia completa para cobrir engines diferentes:
   *  pointerdown -> mousedown -> mouseup -> click, mais pointerup.
   *  Nao move nem usa o mouse fisico.
   * ==========================================================================*/

  function firePointerEvent(el, type, x, y) {
    if (typeof PointerEvent !== 'function') return; // ignora se nao existir
    const ev = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerdown' ? 1 : 0,
      clientX: x,
      clientY: y,
    });
    el.dispatchEvent(ev);
  }

  function fireMouseEvent(el, type, x, y) {
    const ev = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: type === 'mousedown' ? 1 : 0,
      clientX: x,
      clientY: y,
      detail: 1,
    });
    el.dispatchEvent(ev);
  }

  // Dispara UM clique. `manual` marca cliques disparados pelo botao "Testar".
  function doClick(manual) {
    const t = resolveTarget();
    if (!t) return; // resolveTarget ja logou o motivo
    const { el, clientX, clientY } = t;

    firePointerEvent(el, 'pointerdown', clientX, clientY);
    fireMouseEvent(el, 'mousedown', clientX, clientY);
    fireMouseEvent(el, 'mouseup', clientX, clientY);
    fireMouseEvent(el, 'click', clientX, clientY);
    firePointerEvent(el, 'pointerup', clientX, clientY);

    panelLog((manual ? 'TESTE: ' : '') + `clique em (${Math.round(clientX)}, ${Math.round(clientY)})`);
  }

  /* ============================================================================
   *  CALIBRACAO
   *  Arma; no PROXIMO clique real do usuario, captura o elemento (selector) e
   *  as coordenadas x/y relativas ao canvas, loga e ja preenche o painel.
   * ==========================================================================*/

  function armCalibration() {
    calibrating = true;
    panelLog('Calibracao armada: clique no ponto-alvo agora.');
    updateHeader();
    if (ui.calBtn) { ui.calBtn.textContent = 'Clique no alvo...'; ui.calBtn.style.background = '#ff9800'; }
  }

  // Gera um seletor CSS simples e razoavelmente unico para um elemento.
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
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName === node.nodeName) nth++;
      }
      sel += `:nth-of-type(${nth})`;
      parts.unshift(sel);
      if (node.id) { parts[0] = `#${CSS.escape(node.id)}`; break; }
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // Listener de captura para pegar o clique real antes do jogo.
  function onRealClickCapture(e) {
    if (!calibrating) return;
    // Ignora cliques no proprio painel.
    if (ui.box && ui.box.contains(e.target)) return;
    calibrating = false;
    if (ui.calBtn) { ui.calBtn.textContent = 'Calibrar'; ui.calBtn.style.background = ''; }

    const el = e.target;
    const selector = cssPath(el);
    const canvas = document.querySelector(settings.canvasSelector);
    let relX = null, relY = null;
    if (canvas) {
      const r = canvas.getBoundingClientRect();
      relX = Math.round(e.clientX - r.left);
      relY = Math.round(e.clientY - r.top);
    }

    // Preenche automaticamente os campos do painel conforme o modo atual.
    if (settings.targetMode === 'canvas' && canvas) {
      settings.canvasX = relX;
      settings.canvasY = relY;
    } else if (settings.targetMode === 'selector') {
      settings.targetSelector = selector;
    }
    saveSettings();
    syncInputsFromSettings();

    console.log(
      `%c[AutoClick CALIBRACAO ${ts()}]`,
      'color:#ff9800;font-weight:bold',
      '\n  selector :', selector,
      '\n  elemento :', el,
      '\n  canvas x/y (relativo):', (relX === null ? 'canvas nao encontrado' : { x: relX, y: relY })
    );
    panelLog(`Calibrado: ${settings.targetMode === 'canvas' ? `x=${relX}, y=${relY}` : selector}`);
    // NAO chamamos preventDefault: o clique real segue normalmente.
  }

  /* ============================================================================
   *  LIGA / DESLIGA
   * ==========================================================================*/

  function enable() {
    if (enabled) return;
    enabled = true;
    startAudioKeepAlive();
    workerStart();
    panelLog('LIGADO (intervalo ' + (settings.intervalMs / 1000) + 's)');
    updateHeader();
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    workerStop();
    stopAudioKeepAlive();
    panelLog('DESLIGADO');
    updateHeader();
  }

  function toggle() { enabled ? disable() : enable(); }

  /* ============================================================================
   *  AJUSTE DE INTERVALO
   * ==========================================================================*/

  // Aplica um novo intervalo (em ms), persiste e reinicia a contagem se ligado.
  function applyIntervalMs(newMs) {
    settings.intervalMs = clampIntervalMs(newMs);
    saveSettings();
    workerSetInterval();
    syncIntervalUI();
  }

  function incInterval() { applyIntervalMs(settings.intervalMs + CONST.STEP_MS); }
  function decInterval() { applyIntervalMs(settings.intervalMs - CONST.STEP_MS); }

  /* ============================================================================
   *  PAINEL DE AJUSTES
   * ==========================================================================*/

  // CSS do painel injetado uma vez (mantem o HTML limpo).
  const PANEL_CSS = `
    #ac-panel{position:fixed;z-index:2147483647;top:12px;right:12px;width:260px;
      background:rgba(22,24,29,0.92);color:#e6e6e6;font:12px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;
      border:1px solid #3a3f47;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,0.5);
      user-select:none;backdrop-filter:blur(2px)}
    #ac-panel *{box-sizing:border-box}
    #ac-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;
      border-bottom:1px solid #3a3f47}
    #ac-dot{width:11px;height:11px;border-radius:50%;background:#f44336;flex:0 0 auto;
      box-shadow:0 0 6px rgba(0,0,0,0.4)}
    #ac-title{font-weight:700;flex:1 1 auto}
    #ac-power{cursor:pointer;border:0;border-radius:6px;padding:3px 10px;font-weight:600;color:#fff;background:#2e7d32}
    #ac-min{cursor:pointer;border:0;background:transparent;color:#9aa0a8;font-size:16px;line-height:1;padding:0 2px}
    #ac-body{padding:10px}
    .ac-sec{margin-bottom:12px}
    .ac-sec h4{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8b93a1}
    .ac-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
    .ac-lbl{color:#b9c0ca;flex:0 0 auto}
    #ac-panel input[type=text],#ac-panel input[type=number],#ac-panel select{
      background:#14161b;color:#e6e6e6;border:1px solid #454b55;border-radius:5px;padding:3px 6px;
      font:inherit;width:100%}
    #ac-panel input[type=number]{width:64px}
    #ac-slider{flex:1 1 auto}
    .ac-hint{color:#7f8894;font-size:10px;margin-top:2px}
    .ac-btn{cursor:pointer;border:1px solid #454b55;background:#2b2f36;color:#e6e6e6;
      border-radius:6px;padding:4px 8px;font:inherit}
    .ac-btn:hover{background:#353a42}
    .ac-btn.primary{background:#2e7d32;border-color:#2e7d32;color:#fff}
    #ac-count{font-weight:700;color:#7fd1ff}
    #ac-log{background:#0f1114;border:1px solid #2c313a;border-radius:6px;height:96px;
      overflow:auto;padding:5px 7px;font:10px/1.4 monospace;color:#9fe0a5;white-space:pre-wrap;
      word-break:break-word}
    .ac-foot{display:flex;gap:6px;margin-top:8px}
    .ac-foot .ac-btn{flex:1 1 auto}
    #ac-kbd{color:#6b7280;font-size:10px;margin-top:8px}
  `;

  function buildPanel() {
    // Injeta o CSS uma unica vez.
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    document.head.appendChild(style);

    const box = document.createElement('div');
    box.id = 'ac-panel';
    box.innerHTML = `
      <div id="ac-head" title="Arraste para mover o painel">
        <span id="ac-dot"></span>
        <span id="ac-title">Auto-Click</span>
        <button id="ac-power" title="Ligar/Desligar o auto-clique (Alt+K)">Ligar</button>
        <button id="ac-min" title="Recolher/expandir o painel">–</button>
      </div>
      <div id="ac-body">

        <!-- ===== Intervalo ===== -->
        <div class="ac-sec">
          <h4>Intervalo entre cliques</h4>
          <div class="ac-row">
            <input id="ac-slider" type="range" min="${CONST.MIN_INTERVAL_SEC}" max="${CONST.MAX_INTERVAL_SEC}" step="1"
                   title="Arraste para ajustar o intervalo (em segundos)">
            <input id="ac-secs" type="number" min="${CONST.MIN_INTERVAL_SEC}" step="1"
                   title="Digite o intervalo em segundos e tecle Enter">
            <span class="ac-lbl">s</span>
          </div>
          <div class="ac-hint">Proximo clique em: <span id="ac-count">--</span></div>
        </div>

        <!-- ===== Alvo do clique ===== -->
        <div class="ac-sec">
          <h4>Alvo do clique</h4>
          <div class="ac-row">
            <select id="ac-mode" title="Como o alvo do clique e definido">
              <option value="canvas">Coordenadas do canvas</option>
              <option value="selector">CSS selector</option>
            </select>
          </div>

          <!-- Campos do modo canvas -->
          <div id="ac-canvas-fields">
            <div class="ac-row">
              <span class="ac-lbl" style="width:56px">Canvas</span>
              <input id="ac-canvas-sel" type="text" title="Seletor CSS do canvas do jogo (ex: canvas)">
            </div>
            <div class="ac-row">
              <span class="ac-lbl" style="width:56px">X / Y</span>
              <input id="ac-x" type="number" title="X relativo ao canto do canvas">
              <input id="ac-y" type="number" title="Y relativo ao canto do canvas">
            </div>
          </div>

          <!-- Campos do modo selector -->
          <div id="ac-selector-fields">
            <div class="ac-row">
              <span class="ac-lbl" style="width:56px">Seletor</span>
              <input id="ac-sel" type="text" title="Seletor CSS do elemento que recebe o clique">
            </div>
          </div>

          <div class="ac-row">
            <button id="ac-cal" class="ac-btn" title="Ao clicar, o SEU proximo clique real na tela vira o alvo">Calibrar</button>
            <button id="ac-test" class="ac-btn" title="Dispara um unico clique agora para validar o alvo">Testar clique agora</button>
          </div>
          <div class="ac-hint">"Calibrar": clique aqui e depois clique no ponto do jogo &mdash; ele captura o alvo pra voce.</div>
        </div>

        <!-- ===== Log ===== -->
        <div class="ac-sec">
          <h4>Log (ultimos disparos)</h4>
          <div id="ac-log"></div>
        </div>

        <!-- ===== Acoes ===== -->
        <div class="ac-foot">
          <button id="ac-save" class="ac-btn primary" title="Salva a configuracao (ja e salva automaticamente ao alterar)">Salvar</button>
          <button id="ac-reset" class="ac-btn" title="Volta todos os valores para o padrao">Restaurar padroes</button>
        </div>
        <div id="ac-kbd">Alt+K liga/desliga &middot; Alt+= / Alt+- ±30s &middot; Alt+C calibra</div>
      </div>
    `;

    // Cliques dentro do painel nao devem vazar para o jogo / calibracao.
    box.addEventListener('pointerdown', (e) => e.stopPropagation(), true);
    box.addEventListener('click', (e) => e.stopPropagation(), true);

    (document.body || document.documentElement).appendChild(box);

    // Guarda referencias.
    ui.box = box;
    ui.body = box.querySelector('#ac-body');
    ui.dot = box.querySelector('#ac-dot');
    ui.power = box.querySelector('#ac-power');
    ui.minBtn = box.querySelector('#ac-min');
    ui.slider = box.querySelector('#ac-slider');
    ui.secs = box.querySelector('#ac-secs');
    ui.count = box.querySelector('#ac-count');
    ui.mode = box.querySelector('#ac-mode');
    ui.canvasFields = box.querySelector('#ac-canvas-fields');
    ui.selectorFields = box.querySelector('#ac-selector-fields');
    ui.canvasSel = box.querySelector('#ac-canvas-sel');
    ui.x = box.querySelector('#ac-x');
    ui.y = box.querySelector('#ac-y');
    ui.sel = box.querySelector('#ac-sel');
    ui.calBtn = box.querySelector('#ac-cal');
    ui.testBtn = box.querySelector('#ac-test');
    ui.log = box.querySelector('#ac-log');
    ui.saveBtn = box.querySelector('#ac-save');
    ui.resetBtn = box.querySelector('#ac-reset');

    wirePanel();
    restoreUiLayout();
    syncInputsFromSettings();
    syncIntervalUI();
    updateHeader();
  }

  // Liga os eventos dos controles.
  function wirePanel() {
    // Header: liga/desliga + recolher.
    ui.power.addEventListener('click', toggle);
    ui.minBtn.addEventListener('click', toggleCollapse);

    // Intervalo: slider e campo numerico sincronizados.
    ui.slider.addEventListener('input', () => applyIntervalMs(Number(ui.slider.value) * 1000));
    ui.secs.addEventListener('change', () => applyIntervalMs(Number(ui.secs.value) * 1000));
    ui.secs.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyIntervalMs(Number(ui.secs.value) * 1000);
    });

    // Alvo: dropdown de modo.
    ui.mode.addEventListener('change', () => {
      settings.targetMode = ui.mode.value;
      saveSettings();
      updateModeVisibility();
    });

    // Campos de alvo (aplicam ao vivo + salvam).
    ui.canvasSel.addEventListener('change', () => { settings.canvasSelector = ui.canvasSel.value.trim() || 'canvas'; saveSettings(); });
    ui.x.addEventListener('change', () => { settings.canvasX = Number(ui.x.value) || 0; saveSettings(); });
    ui.y.addEventListener('change', () => { settings.canvasY = Number(ui.y.value) || 0; saveSettings(); });
    ui.sel.addEventListener('change', () => { settings.targetSelector = ui.sel.value.trim() || 'canvas'; saveSettings(); });

    // Botoes de alvo.
    ui.calBtn.addEventListener('click', armCalibration);
    ui.testBtn.addEventListener('click', () => doClick(true));

    // Salvar / Restaurar.
    ui.saveBtn.addEventListener('click', () => {
      saveSettings();
      const old = ui.saveBtn.textContent;
      ui.saveBtn.textContent = 'Salvo ✓';
      setTimeout(() => { ui.saveBtn.textContent = old; }, 1200);
      panelLog('Configuracao salva.');
    });
    ui.resetBtn.addEventListener('click', () => {
      settings = Object.assign({}, DEFAULTS);
      saveSettings();
      syncInputsFromSettings();
      applyIntervalMs(settings.intervalMs); // reinicia contagem se ligado
      panelLog('Padroes restaurados.');
    });

    makeDraggable(ui.box, ui.box.querySelector('#ac-head'));
  }

  // Copia os valores de `settings` para os campos do painel.
  function syncInputsFromSettings() {
    if (!ui.mode) return;
    ui.mode.value = settings.targetMode;
    ui.canvasSel.value = settings.canvasSelector;
    ui.x.value = settings.canvasX;
    ui.y.value = settings.canvasY;
    ui.sel.value = settings.targetSelector;
    updateModeVisibility();
  }

  // Mostra so os campos do modo escolhido.
  function updateModeVisibility() {
    const isCanvas = settings.targetMode === 'canvas';
    ui.canvasFields.style.display = isCanvas ? '' : 'none';
    ui.selectorFields.style.display = isCanvas ? 'none' : '';
  }

  // Sincroniza slider + campo numerico com o intervalo atual.
  function syncIntervalUI() {
    if (!ui.slider) return;
    const secs = settings.intervalMs / 1000;
    // O slider tem teto; se o valor for maior, ele fica no maximo (o campo mostra o real).
    ui.slider.value = Math.min(CONST.MAX_INTERVAL_SEC, Math.max(CONST.MIN_INTERVAL_SEC, secs));
    if (document.activeElement !== ui.secs) ui.secs.value = secs;
    refreshCountdown();
  }

  // Atualiza a bolinha ON/OFF e o botao de liga/desliga.
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
    const remaining = Math.max(0, nextClickAt - Date.now());
    const s = Math.ceil(remaining / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    ui.count.textContent = `${mm}:${ss}`;
  }

  // Atualiza a contagem 1x/s (so visual; o timer real vive no Worker).
  setInterval(refreshCountdown, 1000);

  /* ---- Recolher / expandir ------------------------------------------------ */
  function toggleCollapse(forceState) {
    const collapsed = typeof forceState === 'boolean'
      ? forceState
      : ui.body.style.display !== 'none';
    ui.body.style.display = collapsed ? 'none' : '';
    ui.minBtn.textContent = collapsed ? '+' : '–';
    persistUiLayout();
  }

  /* ---- Arrastar o painel pelo cabecalho ----------------------------------- */
  function makeDraggable(box, handle) {
    let dragging = false, offX = 0, offY = 0;
    handle.addEventListener('pointerdown', (e) => {
      // Nao inicia arrasto se clicou nos botoes do cabecalho.
      if (e.target.closest('button')) return;
      dragging = true;
      const r = box.getBoundingClientRect();
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      // Passa a posicionar por left/top (solta o "right").
      box.style.right = 'auto';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      let left = e.clientX - offX;
      let top = e.clientY - offY;
      // Mantem dentro da janela.
      left = Math.max(0, Math.min(window.innerWidth - box.offsetWidth, left));
      top = Math.max(0, Math.min(window.innerHeight - 30, top));
      box.style.left = left + 'px';
      box.style.top = top + 'px';
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
    saveUiState({
      left: r.left,
      top: r.top,
      collapsed: ui.body.style.display === 'none',
    });
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
    // Nao interfere se o usuario estiver digitando dentro do painel.
    if (ui.box && ui.box.contains(e.target)) return;

    const key = (e.key || '').toLowerCase();
    if (key === CONST.HOTKEY_TOGGLE) { e.preventDefault(); toggle(); }
    else if (key === CONST.HOTKEY_CALIBRATE) { e.preventDefault(); armCalibration(); }
    else if (e.key === CONST.HOTKEY_INC || key === CONST.HOTKEY_INC) { e.preventDefault(); incInterval(); }
    else if (e.key === CONST.HOTKEY_DEC || key === CONST.HOTKEY_DEC) { e.preventDefault(); decInterval(); }
  }

  /* ============================================================================
   *  INICIALIZACAO
   * ==========================================================================*/

  function init() {
    loadSettings();
    buildPanel();
    // Calibracao: captura o clique real antes que o jogo o consuma.
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
