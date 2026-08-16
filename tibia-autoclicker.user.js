// ==UserScript==
// @name         Tibia Auto-Clicker (canvas)
// @namespace    https://github.com/mrfeederr/auto-click
// @version      1.2.1
// @description  Auto-clique sintetico a cada X minutos em jogo de navegador (canvas). Ate 4 cliques em sequencia com delay, funciona em background (Web Worker + audio silencioso), painel de ajustes didatico e calibracao.
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
   *  apenas os PADROES iniciais (primeira vez e "Restaurar padroes").
   * ==========================================================================*/

  // Como e um alvo de clique. Ate 4 deles sao disparados em sequencia por ciclo.
  //   enabled        -> se este clique participa da sequencia
  //   mode           -> 'canvas' (coordenadas x/y no canvas) ou 'selector' (CSS)
  //   canvasSelector -> seletor do canvas do jogo (modo canvas)
  //   canvasX/canvasY-> coordenadas relativas ao canto do canvas (modo canvas)
  //   selector       -> seletor CSS do elemento (modo selector)
  function defaultStep(enabled) {
    return {
      enabled: !!enabled,
      mode: 'canvas',
      canvasSelector: 'canvas',
      canvasX: 400,
      canvasY: 300,
      selector: 'canvas',
    };
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
    MIN_INTERVAL_SEC: 5,     // intervalo minimo (nao deixa "zerar")
    MAX_INTERVAL_SEC: 600,   // maximo do slider (10 min); o campo aceita mais
    STEP_MS: 30000,          // passo dos atalhos Alt+= / Alt+- (30 s)
    MAX_STEPS: 4,            // quantidade de cliques na sequencia

    // Atalhos (sempre combinados com Alt)
    HOTKEY_TOGGLE: 'k',      // Alt+K  -> liga/desliga
    HOTKEY_CALIBRATE: 'c',   // Alt+C  -> calibra o clique 1
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

  let settings = clone(DEFAULTS);   // config corrente (usada nos cliques)
  let enabled = false;              // auto-clique ligado?
  let calibrateTarget = null;       // indice do step em calibracao, ou null
  let nextClickAt = 0;              // timestamp (ms) do proximo ciclo
  let worker = null;                // Web Worker que "bate" o tempo em background
  let audioCtx = null;              // contexto WebAudio do keep-alive
  const ui = {};                    // referencias aos elementos do painel
  ui.steps = [];                    // referencias aos blocos de cada clique
  const logLines = [];              // ultimas linhas da mini-area de log

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

      // Migracao de versoes antigas (config "achatada" com 1 alvo so).
      if (obj && !obj.steps && obj.targetMode) {
        const s0 = defaultStep(true);
        s0.mode = obj.targetMode;
        s0.canvasSelector = obj.canvasSelector || s0.canvasSelector;
        s0.canvasX = obj.canvasX != null ? obj.canvasX : s0.canvasX;
        s0.canvasY = obj.canvasY != null ? obj.canvasY : s0.canvasY;
        s0.selector = obj.targetSelector || s0.selector;
        obj.steps = [s0, defaultStep(false), defaultStep(false), defaultStep(false)];
      }

      settings = Object.assign(clone(DEFAULTS), obj);
      // Garante exatamente MAX_STEPS steps, completos.
      const steps = [];
      for (let i = 0; i < CONST.MAX_STEPS; i++) {
        steps[i] = Object.assign(defaultStep(i === 0), (obj.steps && obj.steps[i]) || {});
      }
      settings.steps = steps;
      settings.intervalMs = clampIntervalMs(settings.intervalMs);
      settings.betweenClicksMs = Math.max(0, Number(settings.betweenClicksMs) || 0);
    } catch (e) {
      console.warn('[AutoClick] Config salva invalida, usando padroes.', e);
      settings = clone(DEFAULTS);
    }
  }

  function saveSettings() {
    storageSet(CONST.STORE_SETTINGS, JSON.stringify(settings));
  }

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
    if (ui.log) {
      ui.log.textContent = logLines.join('\n');
      ui.log.scrollTop = ui.log.scrollHeight;
    }
    console.log(`%c[AutoClick ${ts()}]`, 'color:#4caf50;font-weight:bold', msg);
  }

  /* ============================================================================
   *  KEEP-ALIVE DE AUDIO (impede o Chrome de congelar a aba em background)
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
   * ==========================================================================*/

  const WORKER_SRC = `
    let intervalMs = 120000;
    let timer = null;
    function fire() { postMessage({ type: 'tick' }); schedule(); }
    function schedule() { clearTimeout(timer); timer = setTimeout(fire, intervalMs); }
    onmessage = function (e) {
      const msg = e.data || {};
      if (msg.type === 'start') { intervalMs = msg.intervalMs; schedule(); }
      else if (msg.type === 'stop') { clearTimeout(timer); timer = null; }
      else if (msg.type === 'setInterval') {
        intervalMs = msg.intervalMs;
        if (timer !== null) schedule(); // reinicia contagem com o novo valor
      }
    };
  `;

  function createWorker() {
    if (worker) return;
    const blob = new Blob([WORKER_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = function (e) {
      if (e.data && e.data.type === 'tick') {
        runSequence(false);
        nextClickAt = Date.now() + settings.intervalMs;
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
    if (enabled) nextClickAt = Date.now() + settings.intervalMs;
  }

  /* ============================================================================
   *  RESOLUCAO DO ALVO E DISPARO DO CLIQUE SINTETICO
   * ==========================================================================*/

  // Retorna { el, clientX, clientY } para um step, ou null.
  function resolveStepTarget(step) {
    if (step.mode === 'canvas') {
      const canvas = document.querySelector(step.canvasSelector);
      if (!canvas) { panelLog('ERRO: canvas nao encontrado (' + step.canvasSelector + ')'); return null; }
      const r = canvas.getBoundingClientRect();
      const clientX = r.left + Number(step.canvasX);
      const clientY = r.top + Number(step.canvasY);
      let el = document.elementFromPoint(clientX, clientY) || canvas;
      // Se o proprio painel estiver cobrindo o ponto, mira direto no canvas
      // (senao os cliques cairiam no painel em vez do jogo).
      if (ui.box && ui.box.contains(el)) el = canvas;
      return { el, canvas, clientX, clientY };
    }
    const el = document.querySelector(step.selector);
    if (!el) { panelLog('ERRO: alvo nao encontrado (' + step.selector + ')'); return null; }
    const r = el.getBoundingClientRect();
    return { el, canvas: null, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  }

  // Coordenadas de tela aproximadas (algumas engines leem screenX/screenY).
  function screenXY(x, y) {
    return { sx: x + (window.screenX || 0), sy: y + (window.screenY || 0) };
  }

  function firePointerEvent(el, type, x, y, pressure) {
    if (typeof PointerEvent !== 'function') return;
    const { sx, sy } = screenXY(x, y);
    const down = (type === 'pointerdown');
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      width: 1, height: 1, pressure: pressure != null ? pressure : (down ? 0.5 : 0),
      button: down || type === 'pointerup' ? 0 : -1,
      buttons: down ? 1 : 0,
      clientX: x, clientY: y, screenX: sx, screenY: sy,
    }));
  }
  function fireMouseEvent(el, type, x, y) {
    const { sx, sy } = screenXY(x, y);
    const down = (type === 'mousedown');
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      button: 0,
      buttons: down ? 1 : 0,
      clientX: x, clientY: y, screenX: sx, screenY: sy,
      detail: type === 'click' ? 1 : 0,
    }));
  }

  // Dispara UM clique sintetico completo para um step. Retorna true se ok.
  // A sequencia inclui um "move/hover" antes do clique porque muitas engines
  // de canvas (SDL/Emscripten) so registram o clique no ponto onde o ponteiro
  // "esta". Tambem foca a janela/canvas, pois alguns jogos ignoram input sem foco.
  function clickStep(step, label) {
    const t = resolveStepTarget(step);
    if (!t) return false;
    const { el, canvas, clientX, clientY } = t;

    // Garante foco (jogos costumam ignorar input quando a aba/canvas perde foco;
    // clicar num botao do painel tira o foco do jogo).
    try { window.focus(); } catch (e) {}
    try { (canvas || el).focus({ preventScroll: true }); } catch (e) {}

    // 1) Move o ponteiro ate o alvo (hover/aim).
    firePointerEvent(el, 'pointermove', clientX, clientY, 0);
    fireMouseEvent(el, 'mousemove', clientX, clientY);
    // 2) Pressiona.
    firePointerEvent(el, 'pointerdown', clientX, clientY, 0.5);
    fireMouseEvent(el, 'mousedown', clientX, clientY);
    // 3) Solta + click.
    fireMouseEvent(el, 'mouseup', clientX, clientY);
    fireMouseEvent(el, 'click', clientX, clientY);
    firePointerEvent(el, 'pointerup', clientX, clientY, 0);

    const tag = el && el.tagName ? el.tagName.toLowerCase() : '?';
    panelLog(`${label} (${Math.round(clientX)}, ${Math.round(clientY)}) -> <${tag}>`);
    return true;
  }

  // Dispara a sequencia de cliques ativos, com delay entre eles.
  function runSequence(manual) {
    const active = [];
    settings.steps.forEach((s, i) => { if (s.enabled) active.push({ s, i }); });
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
   *  CALIBRACAO (por clique/step)
   * ==========================================================================*/

  function armCalibration(stepIndex) {
    calibrateTarget = stepIndex;
    panelLog(`Calibracao do clique ${stepIndex + 1}: clique no ponto-alvo agora.`);
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

    const step = settings.steps[idx];
    const el = e.target;
    const selector = cssPath(el);
    const canvas = document.querySelector(step.canvasSelector);
    let relX = null, relY = null;
    if (canvas) {
      const r = canvas.getBoundingClientRect();
      relX = Math.round(e.clientX - r.left);
      relY = Math.round(e.clientY - r.top);
    }

    if (step.mode === 'canvas' && canvas) {
      step.canvasX = relX; step.canvasY = relY;
    } else if (step.mode === 'selector') {
      step.selector = selector;
    }
    saveSettings();
    syncStepInputs(idx);

    console.log(`%c[AutoClick CALIBRACAO C${idx + 1} ${ts()}]`, 'color:#ff9800;font-weight:bold',
      '\n  selector :', selector, '\n  elemento :', el,
      '\n  canvas x/y:', (relX === null ? 'canvas nao encontrado' : { x: relX, y: relY }));
    panelLog(`Clique ${idx + 1} calibrado: ${step.mode === 'canvas' ? `x=${relX}, y=${relY}` : selector}`);
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
    #ac-panel input[type=text],#ac-panel input[type=number],#ac-panel select{
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
      font:10px/1.4 monospace;color:#9fe0a5;white-space:pre-wrap;word-break:break-word}
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
        <button id="ac-power" title="Ligar/Desligar o auto-clique (Alt+K)">Ligar</button>
        <button id="ac-min" title="Recolher/expandir o painel">–</button>
      </div>
      <div id="ac-body">

        <div class="ac-sec">
          <h4>Intervalo entre ciclos</h4>
          <div class="ac-row">
            <input id="ac-slider" type="range" min="${CONST.MIN_INTERVAL_SEC}" max="${CONST.MAX_INTERVAL_SEC}" step="1"
                   title="Arraste para ajustar o intervalo (em segundos)">
            <input id="ac-secs" type="number" min="${CONST.MIN_INTERVAL_SEC}" step="1"
                   title="Digite o intervalo em segundos e tecle Enter">
            <span class="ac-lbl">s</span>
          </div>
          <div class="ac-row">
            <span class="ac-lbl" style="flex:1 1 auto">Delay entre cliques</span>
            <input id="ac-between" type="number" min="0" step="50"
                   title="Espera entre um clique e o proximo da sequencia (ms)">
            <span class="ac-lbl">ms</span>
          </div>
          <div class="ac-hint">Proximo ciclo em: <span id="ac-count">--</span></div>
        </div>

        <div class="ac-sec">
          <h4>Cliques da sequencia</h4>
          <div id="ac-steps"></div>
          <div class="ac-hint">Marque quais cliques usar (1 a ${CONST.MAX_STEPS}). Sao disparados em ordem, com o delay acima.</div>
        </div>

        <div class="ac-sec">
          <h4>Log (ultimos disparos)</h4>
          <div id="ac-log"></div>
        </div>

        <div class="ac-foot">
          <button id="ac-runall" class="ac-btn" title="Dispara a sequencia inteira agora">Testar sequencia</button>
          <button id="ac-save" class="ac-btn primary" title="Salva a configuracao (ja e salva ao alterar)">Salvar</button>
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

  // Cria os blocos de cada clique da sequencia.
  function buildSteps() {
    ui.steps = [];
    for (let i = 0; i < CONST.MAX_STEPS; i++) {
      const block = el(`
        <div class="ac-step">
          <div class="ac-step-head">
            <label title="Ative para incluir este clique na sequencia">
              <input type="checkbox" class="ac-en"> Clique ${i + 1}
            </label>
            <button class="ac-btn sm ac-cal" title="Clique aqui e depois clique no ponto do jogo para capturar o alvo">Calibrar</button>
            <button class="ac-btn sm ac-test" title="Dispara so este clique agora">Testar</button>
          </div>
          <div class="ac-row">
            <select class="ac-mode" title="Como o alvo deste clique e definido">
              <option value="canvas">Coordenadas do canvas</option>
              <option value="selector">CSS selector</option>
            </select>
          </div>
          <div class="ac-canvas">
            <div class="ac-row">
              <span class="ac-lbl" style="width:52px">Canvas</span>
              <input type="text" class="ac-csel" title="Seletor CSS do canvas do jogo (ex: canvas)">
            </div>
            <div class="ac-row">
              <span class="ac-lbl" style="width:52px">X / Y</span>
              <input type="number" class="ac-x" title="X relativo ao canto do canvas">
              <input type="number" class="ac-y" title="Y relativo ao canto do canvas">
            </div>
          </div>
          <div class="ac-selector">
            <div class="ac-row">
              <span class="ac-lbl" style="width:52px">Seletor</span>
              <input type="text" class="ac-sel" title="Seletor CSS do elemento que recebe o clique">
            </div>
          </div>
        </div>
      `);

      const refs = {
        block,
        en: block.querySelector('.ac-en'),
        calBtn: block.querySelector('.ac-cal'),
        testBtn: block.querySelector('.ac-test'),
        mode: block.querySelector('.ac-mode'),
        canvasFields: block.querySelector('.ac-canvas'),
        selectorFields: block.querySelector('.ac-selector'),
        csel: block.querySelector('.ac-csel'),
        x: block.querySelector('.ac-x'),
        y: block.querySelector('.ac-y'),
        sel: block.querySelector('.ac-sel'),
      };

      const idx = i;
      refs.en.addEventListener('change', () => {
        settings.steps[idx].enabled = refs.en.checked;
        saveSettings(); updateStepVisual(idx);
      });
      refs.mode.addEventListener('change', () => {
        settings.steps[idx].mode = refs.mode.value;
        saveSettings(); syncStepInputs(idx);
      });
      refs.csel.addEventListener('change', () => { settings.steps[idx].canvasSelector = refs.csel.value.trim() || 'canvas'; saveSettings(); });
      refs.x.addEventListener('change', () => { settings.steps[idx].canvasX = Number(refs.x.value) || 0; saveSettings(); });
      refs.y.addEventListener('change', () => { settings.steps[idx].canvasY = Number(refs.y.value) || 0; saveSettings(); });
      refs.sel.addEventListener('change', () => { settings.steps[idx].selector = refs.sel.value.trim() || 'canvas'; saveSettings(); });
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
    ui.between.addEventListener('change', () => { settings.betweenClicksMs = Math.max(0, Number(ui.between.value) || 0); saveSettings(); });

    box.querySelector('#ac-runall').addEventListener('click', () => runSequence(true));
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

  // Copia settings.steps[i] para os campos do bloco.
  function syncStepInputs(i) {
    const st = ui.steps[i]; const s = settings.steps[i];
    if (!st) return;
    st.en.checked = s.enabled;
    st.mode.value = s.mode;
    st.csel.value = s.canvasSelector;
    st.x.value = s.canvasX;
    st.y.value = s.canvasY;
    st.sel.value = s.selector;
    const isCanvas = s.mode === 'canvas';
    st.canvasFields.style.display = isCanvas ? '' : 'none';
    st.selectorFields.style.display = isCanvas ? 'none' : '';
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
      let left = Math.max(0, Math.min(window.innerWidth - box.offsetWidth, e.clientX - offX));
      let top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - offY));
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
    if (ui.box && ui.box.contains(e.target)) return; // digitando no painel
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
