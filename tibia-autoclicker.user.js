// ==UserScript==
// @name         Tibia Auto-Clicker (canvas)
// @namespace    https://github.com/mrfeederr/auto-click
// @version      1.0.0
// @description  Auto-clique sintetico a cada X minutos em jogo de navegador (canvas), funciona em background com Web Worker + audio silencioso. Painel de controle, calibracao e atalhos.
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
   * ==========================================================================*/

  const CONFIG = {
    // ---- Intervalo entre cliques -------------------------------------------
    // Valor padrao em milissegundos (120000 ms = 2 minutos).
    // Pode ser mudado em tempo real pelo painel ou pelos atalhos, e fica salvo.
    DEFAULT_INTERVAL_MS: 120000,

    // Intervalo minimo permitido (ms). Serve para nao "zerar" o timer.
    MIN_INTERVAL_MS: 5000,

    // Passo dos atalhos Alt+= / Alt+-  (ms). 30000 = 30 segundos.
    STEP_MS: 30000,

    // ---- Alvo do clique -----------------------------------------------------
    // Dois modos possiveis. Escolha em TARGET_MODE:
    //   'selector'  -> clica no elemento apontado por TARGET_SELECTOR
    //   'canvas'    -> clica em coordenadas x/y RELATIVAS ao canvas do jogo
    TARGET_MODE: 'canvas',

    // Modo 'selector': seletor CSS do elemento que recebe o clique.
    TARGET_SELECTOR: 'canvas',

    // Modo 'canvas': seletor do proprio canvas do jogo (o elemento sobre o qual
    // as coordenadas x/y sao medidas). Se houver mais de um canvas, ajuste.
    CANVAS_SELECTOR: 'canvas',

    // Modo 'canvas': coordenadas do clique RELATIVAS ao canto superior-esquerdo
    // do canvas (em pixels de tela / CSS). Use o modo calibracao (Alt+C) para
    // descobrir facilmente estes valores.
    CANVAS_X: 400,
    CANVAS_Y: 300,

    // ---- Atalhos de teclado -------------------------------------------------
    HOTKEY_TOGGLE: 'k',   // Alt+K  -> liga/desliga
    HOTKEY_CALIBRATE: 'c',// Alt+C  -> arma calibracao (proximo clique real)
    HOTKEY_INC: '=',      // Alt+=  -> aumenta intervalo em STEP_MS
    HOTKEY_DEC: '-',      // Alt+-  -> diminui intervalo em STEP_MS

    // ---- Comportamento ao carregar -----------------------------------------
    START_ENABLED: false, // comeca desligado; ligue com Alt+K

    // Chave usada para persistir o intervalo (GM_setValue / localStorage).
    STORAGE_KEY: 'tibia_autoclick_interval_ms',
  };

  /* ============================================================================
   *  ESTADO INTERNO
   * ==========================================================================*/

  let enabled = false;              // auto-clique ligado?
  let intervalMs = CONFIG.DEFAULT_INTERVAL_MS;
  let calibrating = false;          // esperando o proximo clique real do usuario?
  let nextClickAt = 0;              // timestamp (ms) do proximo clique agendado
  let worker = null;                // Web Worker que "bate" o tempo em background
  let audioCtx = null;              // contexto WebAudio do keep-alive
  let ui = {};                      // referencias aos elementos do painel

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

  // Carrega o intervalo salvo (se houver) logo no inicio.
  (function loadSavedInterval() {
    const raw = storageGet(CONFIG.STORAGE_KEY, CONFIG.DEFAULT_INTERVAL_MS);
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed >= CONFIG.MIN_INTERVAL_MS) intervalMs = parsed;
  })();

  /* ============================================================================
   *  LOG COM TIMESTAMP LEGIVEL
   * ==========================================================================*/

  function ts() {
    const d = new Date();
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }
  function log(...args) {
    console.log(`%c[AutoClick ${ts()}]`, 'color:#4caf50;font-weight:bold', ...args);
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
      log('Keep-alive de audio iniciado (silencioso).');
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
   *  Timers com setTimeout/setInterval na thread principal sao estrangulados
   *  pelo Chrome quando a aba esta em background. Rodando o cronometro dentro
   *  de um Worker escapamos disso. O Worker apenas AVISA; o clique acontece na
   *  thread principal.
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
        nextClickAt = Date.now() + intervalMs; // agenda visualmente o proximo
      }
    };
  }

  function workerStart() {
    createWorker();
    nextClickAt = Date.now() + intervalMs;
    worker.postMessage({ type: 'start', intervalMs });
  }

  function workerStop() {
    if (worker) worker.postMessage({ type: 'stop' });
    nextClickAt = 0;
  }

  function workerSetInterval() {
    if (worker) worker.postMessage({ type: 'setInterval', intervalMs });
    // Se ligado, reinicia a contagem regressiva visual tambem.
    if (enabled) nextClickAt = Date.now() + intervalMs;
  }

  /* ============================================================================
   *  RESOLUCAO DO ALVO E DAS COORDENADAS DO CLIQUE
   * ==========================================================================*/

  // Retorna { el, clientX, clientY } de acordo com o TARGET_MODE, ou null.
  function resolveTarget() {
    if (CONFIG.TARGET_MODE === 'canvas') {
      const canvas = document.querySelector(CONFIG.CANVAS_SELECTOR);
      if (!canvas) {
        console.warn('[AutoClick] Canvas nao encontrado:', CONFIG.CANVAS_SELECTOR);
        return null;
      }
      const r = canvas.getBoundingClientRect();
      // Coordenadas relativas ao canvas -> clientX/clientY corretos na tela.
      const clientX = r.left + CONFIG.CANVAS_X;
      const clientY = r.top + CONFIG.CANVAS_Y;
      // O elemento que realmente esta sob esse ponto (pode ser o canvas ou um
      // overlay). Usamos ele como alvo para maxima compatibilidade.
      const el = document.elementFromPoint(clientX, clientY) || canvas;
      return { el, clientX, clientY };
    }

    // Modo 'selector'
    const el = document.querySelector(CONFIG.TARGET_SELECTOR);
    if (!el) {
      console.warn('[AutoClick] Alvo (selector) nao encontrado:', CONFIG.TARGET_SELECTOR);
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
    // PointerEvent nem sempre existe; se nao existir, ignoramos os de pointer.
    if (typeof PointerEvent !== 'function') return;
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

  function doClick() {
    const t = resolveTarget();
    if (!t) { log('Clique abortado: alvo indisponivel.'); return; }
    const { el, clientX, clientY } = t;

    // Sequencia completa de eventos sinteticos.
    firePointerEvent(el, 'pointerdown', clientX, clientY);
    fireMouseEvent(el, 'mousedown', clientX, clientY);
    fireMouseEvent(el, 'mouseup', clientX, clientY);
    fireMouseEvent(el, 'click', clientX, clientY);
    firePointerEvent(el, 'pointerup', clientX, clientY);

    log(`Clique disparado em (${Math.round(clientX)}, ${Math.round(clientY)}) ->`, el);
  }

  /* ============================================================================
   *  CALIBRACAO
   *  Alt+C arma; no PROXIMO clique real do usuario, capturamos o elemento
   *  (selector) e as coordenadas x/y relativas ao canvas, e logamos.
   * ==========================================================================*/

  function armCalibration() {
    calibrating = true;
    log('%cCALIBRACAO ARMADA: clique no ponto-alvo agora.', 'color:#ff9800;font-weight:bold');
    updatePanel();
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
      // Posicao entre irmaos de mesmo tipo (nth-of-type).
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

  // Listener de captura (fase de captura) para pegar o clique antes do jogo.
  function onRealClickCapture(e) {
    if (!calibrating) return;
    calibrating = false;

    const el = e.target;
    const selector = cssPath(el);

    // Coordenadas relativas ao canvas do jogo.
    const canvas = document.querySelector(CONFIG.CANVAS_SELECTOR);
    let rel = 'canvas nao encontrado';
    if (canvas) {
      const r = canvas.getBoundingClientRect();
      const relX = Math.round(e.clientX - r.left);
      const relY = Math.round(e.clientY - r.top);
      rel = { x: relX, y: relY };
    }

    console.log(
      `%c[AutoClick CALIBRACAO ${ts()}]`,
      'color:#ff9800;font-weight:bold',
      '\n  selector :', selector,
      '\n  elemento :', el,
      '\n  clientX/Y:', Math.round(e.clientX), Math.round(e.clientY),
      '\n  canvas x/y (relativo):', rel,
      '\n  --> copie para CONFIG.CANVAS_X / CONFIG.CANVAS_Y (ou TARGET_SELECTOR)'
    );
    updatePanel();
    // NAO chamamos preventDefault: deixamos o clique real seguir normalmente.
  }

  /* ============================================================================
   *  LIGA / DESLIGA
   * ==========================================================================*/

  function enable() {
    if (enabled) return;
    enabled = true;
    startAudioKeepAlive();
    workerStart();
    log('%cESTADO: LIGADO', 'color:#4caf50;font-weight:bold', `| intervalo = ${(intervalMs / 1000)}s`);
    updatePanel();
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    workerStop();
    stopAudioKeepAlive();
    log('%cESTADO: DESLIGADO', 'color:#f44336;font-weight:bold');
    updatePanel();
  }

  function toggle() { enabled ? disable() : enable(); }

  /* ============================================================================
   *  AJUSTE DE INTERVALO
   * ==========================================================================*/

  function setIntervalMs(newMs, { persist = true } = {}) {
    newMs = Math.max(CONFIG.MIN_INTERVAL_MS, Math.round(newMs));
    intervalMs = newMs;
    if (persist) storageSet(CONFIG.STORAGE_KEY, intervalMs);
    workerSetInterval(); // se ligado, reinicia a contagem com o novo valor
    log(`Intervalo ajustado para ${(intervalMs / 1000)}s.`);
    updatePanel();
  }

  function incInterval() { setIntervalMs(intervalMs + CONFIG.STEP_MS); }
  function decInterval() { setIntervalMs(intervalMs - CONFIG.STEP_MS); }

  /* ============================================================================
   *  PAINEL FLUTUANTE
   * ==========================================================================*/

  function buildPanel() {
    const box = document.createElement('div');
    box.id = 'autoclick-panel';
    box.style.cssText = [
      'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483647',
      'background:rgba(20,20,24,0.92)', 'color:#eee', 'font:12px/1.4 monospace',
      'padding:10px 12px', 'border:1px solid #444', 'border-radius:8px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.5)', 'min-width:190px',
      'user-select:none',
    ].join(';');

    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="color:#4caf50">Auto-Click</strong>
        <span id="ac-state" style="font-weight:bold"></span>
      </div>
      <div style="margin-bottom:4px">Intervalo: <span id="ac-interval"></span></div>
      <div style="margin-bottom:6px">Proximo: <span id="ac-count"></span></div>
      <div style="display:flex;gap:4px;margin-bottom:6px">
        <input id="ac-input" type="number" min="5" step="1" placeholder="seg"
          style="width:70px;background:#111;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 4px"/>
        <button id="ac-apply"
          style="cursor:pointer;background:#2e7d32;color:#fff;border:0;border-radius:4px;padding:2px 8px">Aplicar</button>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:6px">
        <button id="ac-toggle" style="flex:1;cursor:pointer;background:#333;color:#fff;border:1px solid #555;border-radius:4px;padding:3px">Ligar/Desligar</button>
        <button id="ac-cal" style="flex:1;cursor:pointer;background:#333;color:#fff;border:1px solid #555;border-radius:4px;padding:3px">Calibrar</button>
      </div>
      <div style="color:#888;font-size:10px">Alt+K liga | Alt+= / Alt+- 30s | Alt+C calibra</div>
    `;

    // Impede que cliques no painel sejam capturados pela calibracao / jogo.
    box.addEventListener('pointerdown', (e) => e.stopPropagation(), true);
    box.addEventListener('click', (e) => e.stopPropagation(), true);

    (document.body || document.documentElement).appendChild(box);

    ui.state = box.querySelector('#ac-state');
    ui.interval = box.querySelector('#ac-interval');
    ui.count = box.querySelector('#ac-count');
    ui.input = box.querySelector('#ac-input');

    box.querySelector('#ac-apply').addEventListener('click', () => {
      const secs = parseFloat(ui.input.value);
      if (!isNaN(secs) && secs > 0) setIntervalMs(secs * 1000);
    });
    ui.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const secs = parseFloat(ui.input.value);
        if (!isNaN(secs) && secs > 0) setIntervalMs(secs * 1000);
      }
    });
    box.querySelector('#ac-toggle').addEventListener('click', toggle);
    box.querySelector('#ac-cal').addEventListener('click', armCalibration);

    updatePanel();
  }

  function updatePanel() {
    if (!ui.state) return;
    ui.state.textContent = calibrating ? 'CALIBRANDO' : (enabled ? 'ON' : 'OFF');
    ui.state.style.color = calibrating ? '#ff9800' : (enabled ? '#4caf50' : '#f44336');
    ui.interval.textContent = `${(intervalMs / 1000)}s`;
    // Deixa o campo mostrando o valor atual (em segundos) como referencia.
    if (document.activeElement !== ui.input) ui.input.value = intervalMs / 1000;
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

  // Atualiza a contagem regressiva na tela 1x por segundo (so visual; o timer
  // real que dispara o clique vive no Worker).
  setInterval(refreshCountdown, 1000);

  /* ============================================================================
   *  ATALHOS DE TECLADO
   * ==========================================================================*/

  function onKeyDown(e) {
    if (!e.altKey) return;
    // Nao interfere se o usuario estiver digitando no campo do painel.
    if (e.target === ui.input) return;

    const key = e.key.toLowerCase();
    if (key === CONFIG.HOTKEY_TOGGLE) { e.preventDefault(); toggle(); }
    else if (key === CONFIG.HOTKEY_CALIBRATE) { e.preventDefault(); armCalibration(); }
    else if (e.key === CONFIG.HOTKEY_INC || key === CONFIG.HOTKEY_INC) { e.preventDefault(); incInterval(); }
    else if (e.key === CONFIG.HOTKEY_DEC || key === CONFIG.HOTKEY_DEC) { e.preventDefault(); decInterval(); }
  }

  /* ============================================================================
   *  INICIALIZACAO
   * ==========================================================================*/

  function init() {
    buildPanel();
    // Listener de calibracao na fase de CAPTURA para pegar o clique real antes
    // que o jogo o consuma.
    window.addEventListener('click', onRealClickCapture, true);
    window.addEventListener('keydown', onKeyDown, true);

    log('Script carregado.', `Intervalo salvo/atual: ${(intervalMs / 1000)}s.`,
        'Alt+K para ligar. Alt+C para calibrar o alvo.');

    if (CONFIG.START_ENABLED) enable();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
