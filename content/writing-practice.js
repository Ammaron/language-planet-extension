/**
 * Optional character-writing practice for an eligible Chinese word popup.
 * Loaded before popup.js; exposes LangslyWritingPractice on globalThis.
 *
 * Dormant until opened: this file only defines functions. The Hanzi Writer
 * library is injected by the background on the learner's explicit click, and
 * stroke data comes from packaged, checksum-verified files.
 *
 * The adapter mirrors the web app's writerAdapter.ts: Hanzi Writer's default
 * render target adds document-level mouseup/touchend listeners it never
 * removes, so a scoped Pointer Events render target is injected instead and
 * every listener is registered here and removed on close. Cancelled strokes
 * are discarded, never graded, and every quiz option is passed explicitly.
 */
/* global browser */

const LangslyWritingPractice = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MODES = ['trace', 'watch', 'write'];
  const SIMPLIFIED_TARGET = /^zh(?:-(?:hans|cn|sg))?$/;
  const HAN = /\p{Script=Han}/u;
  const SURFACE_SIZE = 220;
  // Extension practice uses the beginner preset (proposed leniency, pending
  // educator review) and retry-stroke failure handling. Wrong-order and
  // backwards strokes are always rejected and never auto-accepted.
  const LENIENCY = 1.3;
  const HINT_AFTER_MISSES = 3;
  // An outside click right after a stroke ends belongs to the stroke.
  const STROKE_CLICK_GRACE_MS = 400;

  function t(key, fallback) {
    if (globalThis.LangslyI18n) return globalThis.LangslyI18n.t(key, fallback);
    return fallback || key;
  }

  // ─── Eligibility ────────────────────────────────────────────────────────

  /**
   * Returns a normalized practice reference or null. Only the word's own
   * target language counts; the page or interface language never does.
   */
  function eligibleReference(state, { enabled = true } = {}) {
    if (!enabled || !state) return null;
    const reference = state.hanziWriting;
    if (!reference || typeof reference !== 'object') return null;
    if (reference.feature !== 'hanzi-writing' || reference.script !== 'Hans') return null;
    const target = String(state.termLanguage || '').trim().toLowerCase().replace(/_/g, '-');
    if (!SIMPLIFIED_TARGET.test(target)) return null;
    if (state.grammarForm) return null;
    const vocabularyWordId = String(reference.vocabulary_word_id || '');
    const characters = Array.isArray(reference.characters) ? reference.characters : [];
    if (!vocabularyWordId || !characters.length) return null;
    // The popup must be showing exactly the canonical term the server checked.
    const term = characters.map(entry => String(entry && entry.text || '')).join('');
    if (term !== String(state.translation || '')) return null;
    const writable = characters
      .filter(entry => entry && HAN.test(String(entry.text || '')))
      .map(entry => ({
        index: Number(entry.index),
        text: String(entry.text),
        supported: entry.status === 'supported' && typeof entry.data_version === 'string' && typeof entry.sha256 === 'string',
        dataVersion: String(entry.data_version || ''),
        sha256: String(entry.sha256 || ''),
      }));
    if (!writable.some(entry => entry.supported)) return null;
    return { vocabularyWordId, term, characters: writable };
  }

  // ─── Listener registry and scoped render target ────────────────────────

  function createRegistry() {
    let records = [];
    return {
      activePointerId: null,
      onCancel: null,
      lastStrokeEndedAt: 0,
      add(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        records.push({ target, type, handler, options });
      },
      get size() { return records.length; },
      removeAll() {
        for (const { target, type, handler, options } of records) target.removeEventListener(type, handler, options);
        records = [];
        this.activePointerId = null;
        this.onCancel = null;
      },
    };
  }

  function createRenderTarget(svg, defs, registry) {
    const owner = svg;
    const point = typeof owner.createSVGPoint === 'function' ? owner.createSVGPoint() : null;
    const target = {
      node: svg,
      svg,
      defs,
      createSubRenderTarget() {
        const group = svg.ownerDocument.createElementNS(SVG_NS, 'g');
        svg.appendChild(group);
        return createRenderTarget(group, defs, registry);
      },
      getBoundingClientRect() { return svg.getBoundingClientRect(); },
      updateDimensions(width, height) {
        svg.setAttribute('width', `${width}`);
        svg.setAttribute('height', `${height}`);
      },
      addPointerStartListener(callback) {
        registry.add(svg, 'pointerdown', (evt) => {
          if (evt.pointerType === 'mouse' && evt.button !== 0) return;
          // One stroke at a time: a second finger never starts a parallel stroke.
          if (registry.activePointerId !== null) return;
          registry.activePointerId = evt.pointerId;
          try { svg.setPointerCapture?.(evt.pointerId); } catch { /* synthetic events cannot be captured */ }
          callback(eventify(evt));
        });
      },
      addPointerMoveListener(callback) {
        registry.add(svg, 'pointermove', (evt) => {
          if (evt.pointerId !== registry.activePointerId) return;
          callback(eventify(evt));
        });
      },
      addPointerEndListener(callback) {
        const release = (pointerId) => {
          registry.activePointerId = null;
          registry.lastStrokeEndedAt = Date.now();
          try { if (svg.hasPointerCapture?.(pointerId)) svg.releasePointerCapture?.(pointerId); } catch { /* already released */ }
        };
        const cancel = (evt) => {
          if (evt.pointerId !== registry.activePointerId) return;
          release(evt.pointerId);
          registry.onCancel?.();
        };
        registry.add(svg, 'pointerup', (evt) => {
          if (evt.pointerId !== registry.activePointerId) return;
          release(evt.pointerId);
          callback();
        });
        registry.add(svg, 'pointercancel', cancel);
        // Fires after pointerup too; by then activePointerId is already cleared.
        registry.add(svg, 'lostpointercapture', cancel);
      },
    };

    function localPoint(evt) {
      const matrix = typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
      if (point && matrix) {
        point.x = evt.clientX;
        point.y = evt.clientY;
        const local = point.matrixTransform(matrix.inverse());
        return { x: local.x, y: local.y };
      }
      const { left, top } = svg.getBoundingClientRect();
      return { x: evt.clientX - left, y: evt.clientY - top };
    }

    function eventify(evt) {
      return { getPoint: () => localPoint(evt), preventDefault: () => evt.preventDefault() };
    }

    return target;
  }

  function createScopedRenderTarget(container, width, height, registry) {
    const doc = container.ownerDocument;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    // Drawing on the surface must not scroll or zoom the page.
    svg.style.touchAction = 'none';
    container.appendChild(svg);
    const defs = doc.createElementNS(SVG_NS, 'defs');
    svg.appendChild(defs);
    return createRenderTarget(svg, defs, registry);
  }

  // ─── Writer session ─────────────────────────────────────────────────────

  function quizOptionsFor(mode) {
    return {
      leniency: LENIENCY,
      acceptBackwardsStrokes: false,
      markStrokeCorrectAfterMisses: false,
      // Hints belong to guided tracing; writing from memory gets none.
      showHintAfterMisses: mode === 'trace' ? HINT_AFTER_MISSES : false,
    };
  }

  function writerOptionsFor(mode, reducedMotion) {
    const calm = !!reducedMotion;
    return {
      width: SURFACE_SIZE,
      height: SURFACE_SIZE,
      padding: Math.round(SURFACE_SIZE * 0.06),
      showOutline: mode !== 'write',
      showCharacter: false,
      strokeColor: '#1f2937',
      outlineColor: '#d1d5db',
      drawingColor: '#2563eb',
      highlightColor: '#f59e0b',
      radicalColor: null,
      drawingWidth: Math.max(4, Math.round(SURFACE_SIZE / 40)),
      strokeAnimationSpeed: calm ? 1000 : 0.8,
      delayBetweenStrokes: calm ? 0 : 600,
      strokeFadeDuration: calm ? 0 : 300,
      drawingFadeDuration: calm ? 0 : 300,
      strokeHighlightSpeed: calm ? 1 : 2,
      strokeHighlightDuration: calm ? 0 : 200,
      highlightOnComplete: false,
    };
  }

  function createSession({ element, character, mode, loadData, writerFactory, lifecycleDocument, reducedMotion, callbacks = {} }) {
    const registry = createRegistry();
    const quizOptions = quizOptionsFor(mode);
    const state = { strokeIndex: 0, strokeCount: 0, totalMistakes: 0, hintsUsed: 0, complete: false };
    let destroyed = false;
    let watchShown = 0;
    let quizGeneration = 0;
    let loadGeneration = 0;
    let lastLoadError = null;
    const alive = () => !destroyed;

    const writer = writerFactory(element, character, {
      ...writerOptionsFor(mode, reducedMotion),
      ...quizOptions,
      rendererOverride: {
        createRenderTarget: (el, width, height) => createScopedRenderTarget(el, width, height, registry),
      },
      charDataLoader: (char) => {
        const generation = loadGeneration;
        return loadData(char).then((data) => {
          // Ignore stale responses after a character change or teardown.
          if (!alive() || generation !== loadGeneration) return new Promise(() => {});
          return data;
        });
      },
      onLoadCharDataError: (error) => {
        lastLoadError = error instanceof Error ? error : new Error('Stroke data could not be loaded.');
      },
    });

    const startQuiz = (fromStroke) => {
      quizGeneration += 1;
      const generation = quizGeneration;
      const guard = fn => (...args) => { if (alive() && generation === quizGeneration) fn(...args); };
      return writer.quiz({
        ...quizOptions,
        quizStartStrokeNum: fromStroke,
        onCorrectStroke: guard((data) => {
          state.strokeIndex = Number(data.strokeNum) + 1;
          callbacks.onCorrectStroke?.({ strokeIndex: state.strokeIndex, strokeCount: state.strokeCount });
        }),
        onMistake: guard((data) => {
          state.totalMistakes += 1;
          const misses = Number(data && data.mistakesOnStroke || 0);
          callbacks.onMistake?.({ mistakesOnStroke: misses, isBackwards: !!(data && data.isBackwards) });
          if (quizOptions.showHintAfterMisses !== false && misses >= quizOptions.showHintAfterMisses) {
            state.hintsUsed += 1;
          }
        }),
        onComplete: guard(() => {
          state.complete = true;
          state.strokeIndex = state.strokeCount;
          callbacks.onComplete?.({ mistakes: state.totalMistakes, hintsUsed: state.hintsUsed });
        }),
      });
    };

    const prepareMode = async () => {
      const data = await writer.getCharacterData();
      if (!alive()) return false;
      state.strokeCount = data.strokes.length;
      if (mode === 'watch') {
        await writer.hideCharacter({ duration: 0 });
        watchShown = 0;
      } else {
        await startQuiz(0);
      }
      if (alive()) callbacks.onReady?.({ strokeCount: state.strokeCount });
      return alive();
    };

    const cancelInProgressStroke = () => {
      if (!alive() || mode === 'watch' || state.complete) return;
      writer.cancelQuiz();
      void startQuiz(state.strokeIndex);
      callbacks.onStrokeCancelled?.();
    };
    registry.onCancel = cancelInProgressStroke;

    if (lifecycleDocument) {
      registry.add(lifecycleDocument, 'visibilitychange', () => {
        if (lifecycleDocument.visibilityState === 'hidden' && registry.activePointerId !== null) {
          registry.activePointerId = null;
          cancelInProgressStroke();
        }
      });
    }

    const reportLoadFailure = (error) => {
      if (alive()) callbacks.onLoadError?.(lastLoadError || (error instanceof Error ? error : new Error(String(error))));
      lastLoadError = null;
      return false;
    };

    let ready = prepareMode().catch(reportLoadFailure);

    return {
      mode,
      character,
      get ready() { return ready; },
      get drawing() { return registry.activePointerId !== null || Date.now() - registry.lastStrokeEndedAt < STROKE_CLICK_GRACE_MS; },
      async playAll() {
        if (!alive() || mode !== 'watch') return;
        await writer.animateCharacter();
        if (!alive()) return;
        watchShown = state.strokeCount;
        callbacks.onWatchProgress?.({ shownStrokes: watchShown, strokeCount: state.strokeCount });
      },
      async nextStroke() {
        if (!alive() || mode !== 'watch') return;
        if (watchShown >= state.strokeCount) {
          await writer.hideCharacter({ duration: 0 });
          watchShown = 0;
        }
        const index = watchShown;
        watchShown += 1;
        await writer.animateStroke(index);
        if (alive()) callbacks.onWatchProgress?.({ shownStrokes: watchShown, strokeCount: state.strokeCount });
      },
      async showMe() {
        if (!alive() || mode !== 'trace') return false;
        state.hintsUsed += 1;
        writer.cancelQuiz();
        await writer.animateCharacter();
        if (!alive()) return false;
        await writer.hideCharacter({ duration: 0 });
        state.complete = false;
        await startQuiz(state.strokeIndex);
        return true;
      },
      hint() {
        if (!alive() || mode !== 'trace' || state.complete) return false;
        state.hintsUsed += 1;
        void writer.highlightStroke(state.strokeIndex);
        return true;
      },
      async restart() {
        if (!alive()) return;
        state.strokeIndex = 0;
        state.complete = false;
        state.totalMistakes = 0;
        state.hintsUsed = 0;
        if (mode === 'watch') {
          await writer.hideCharacter({ duration: 0 });
          watchShown = 0;
          return;
        }
        writer.cancelQuiz();
        await startQuiz(0);
      },
      async retryLoad() {
        if (!alive()) return false;
        loadGeneration += 1;
        lastLoadError = null;
        ready = writer.setCharacter(character).then(() => prepareMode()).catch(reportLoadFailure);
        return ready;
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        loadGeneration += 1;
        quizGeneration += 1;
        try {
          writer.cancelQuiz();
          writer.pauseAnimation();
        } catch {
          // The writer may not have finished loading; teardown continues.
        }
        registry.removeAll();
        while (element.firstChild) element.removeChild(element.firstChild);
      },
      get destroyed() { return destroyed; },
      get listenerCount() { return registry.size; },
      get state() { return { ...state }; },
    };
  }

  // ─── Runtime bridges (background owns library injection and data) ──────

  async function ensureLibrary(runtime) {
    if (typeof globalThis.HanziWriter === 'function' || typeof globalThis.HanziWriter === 'object') return globalThis.HanziWriter;
    const response = await runtime.sendMessage({ type: 'HANZI_WRITER_LOAD' });
    if (!response || !response.success || !globalThis.HanziWriter) throw new Error('writer_unavailable');
    return globalThis.HanziWriter;
  }

  function dataLoaderFor(runtime, entry) {
    return async (char) => {
      if (char !== entry.text) throw new Error('unexpected_character');
      const response = await runtime.sendMessage({
        type: 'HANZI_CHARACTER_DATA', character: entry.text, data_version: entry.dataVersion, sha256: entry.sha256,
      });
      if (!response || !response.success || !response.data) throw new Error(response && response.error || 'data_unavailable');
      return response.data;
    };
  }

  function newAttemptId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // ─── Panel ──────────────────────────────────────────────────────────────

  function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function button(doc, className, label, onClick, registry) {
    const node = el(doc, 'button', className, label);
    node.type = 'button';
    registry.add(node, 'click', (event) => {
      if (!event.isTrusted) return;
      event.stopPropagation();
      onClick(event);
    });
    return node;
  }

  /**
   * Opens the practice panel inside ``host`` (the popup, already in a closed
   * shadow root). Returns a controller whose ``close()`` removes every
   * listener and the writer. Callers own the popup; the panel never closes it
   * directly but asks through onBack / onClose.
   */
  function openPanel({
    host, anchor, reference, onBack, onClose,
    runtime = globalThis.browser && globalThis.browser.runtime,
    doc = host.ownerDocument,
    writerFactory = (element, character, options) => globalThis.HanziWriter.create(element, character, options),
    libraryLoader = () => ensureLibrary(runtime),
    reducedMotion = !!(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches),
    MutationObserverImpl = globalThis.MutationObserver,
  }) {
    const registry = createRegistry();
    const view = doc.defaultView || globalThis;
    let session = null;
    let closed = false;
    let characterIndex = Math.max(0, reference.characters.findIndex(entry => entry.supported));
    let mode = 'trace';
    let observer = null;
    let started = Promise.resolve();

    const panel = el(doc, 'div', 'lp-writing-panel');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', t('practiceWritingTitle', 'Practice writing'));
    const header = el(doc, 'div', 'lp-writing-header');
    header.appendChild(el(doc, 'span', 'lp-writing-title', t('practiceWritingTitle', 'Practice writing')));
    header.appendChild(el(doc, 'span', 'lp-writing-term', reference.term));
    panel.appendChild(header);

    const nav = el(doc, 'div', 'lp-writing-nav');
    const prev = button(doc, 'lp-popup-listen lp-writing-nav-btn', '‹', () => selectCharacter(characterIndex - 1), registry);
    prev.setAttribute('aria-label', t('writingPrevCharacter', 'Previous character'));
    const position = el(doc, 'span', 'lp-writing-position');
    const next = button(doc, 'lp-popup-listen lp-writing-nav-btn', '›', () => selectCharacter(characterIndex + 1), registry);
    next.setAttribute('aria-label', t('writingNextCharacter', 'Next character'));
    nav.append(prev, position, next);
    if (reference.characters.length > 1) panel.appendChild(nav);

    const modes = el(doc, 'div', 'lp-writing-modes');
    modes.setAttribute('role', 'group');
    const modeButtons = {};
    const modeLabels = { trace: t('writingModeTrace', 'Trace'), watch: t('writingModeWatch', 'Watch'), write: t('writingModeWrite', 'Write') };
    for (const item of MODES) {
      modeButtons[item] = button(doc, 'lp-popup-listen lp-writing-mode', modeLabels[item], () => selectMode(item), registry);
      modes.appendChild(modeButtons[item]);
    }
    panel.appendChild(modes);

    const surface = el(doc, 'div', 'lp-writing-surface');
    panel.appendChild(surface);
    const status = el(doc, 'div', 'lp-writing-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    panel.appendChild(status);
    const tools = el(doc, 'div', 'lp-popup-actions lp-writing-tools');
    panel.appendChild(tools);
    panel.appendChild(el(doc, 'div', 'lp-popup-hint lp-writing-note', t('writingOrderNote', 'Stroke order and direction follow the standard mainland order. Practice only; it never changes lessons or scores.')));
    const footer = el(doc, 'div', 'lp-popup-actions lp-writing-footer');
    footer.append(
      button(doc, 'lp-popup-listen', t('writingBackToWord', 'Back to word'), () => onBack?.(), registry),
      button(doc, 'lp-popup-listen', t('writingClose', 'Close'), () => onClose?.({ reason: 'button' }), registry),
    );
    panel.appendChild(footer);
    host.appendChild(panel);

    function setStatus(text) { status.textContent = text; }

    function renderTools() {
      tools.textContent = '';
      const entry = reference.characters[characterIndex];
      if (!entry || !entry.supported || !session) return;
      if (mode === 'watch') {
        tools.append(
          button(doc, 'lp-popup-listen', t('writingPlay', 'Play'), () => void session?.playAll(), registry),
          button(doc, 'lp-popup-listen', t('writingNextStroke', 'Next stroke'), () => void session?.nextStroke(), registry),
        );
        return;
      }
      if (mode === 'trace') {
        tools.append(
          button(doc, 'lp-popup-listen', t('writingHint', 'Hint'), () => session?.hint(), registry),
          button(doc, 'lp-popup-listen', t('writingShowMe', 'Show me'), () => void session?.showMe(), registry),
        );
      }
      tools.append(button(doc, 'lp-popup-listen', t('writingRestart', 'Start again'), () => {
        void session?.restart();
        setStatus(readyText());
      }, registry));
    }

    function readyText() {
      if (mode === 'watch') return t('writingWatchReady', 'Play the strokes, or step through them one at a time.');
      if (mode === 'write') return t('writingWriteReady', 'Write the character from memory, one stroke at a time.');
      return t('writingTraceReady', 'Trace each stroke in order over the outline.');
    }

    function record(entry, summary) {
      if (!runtime || typeof runtime.sendMessage !== 'function') return;
      Promise.resolve(runtime.sendMessage({
        type: 'HANZI_PRACTICE_RECORD',
        summary: {
          vocabulary_word_id: reference.vocabularyWordId,
          character_index: entry.index,
          character: entry.text,
          data_version: entry.dataVersion,
          mode,
          outcome: mode === 'watch' ? 'watched' : 'completed',
          mistakes: mode === 'watch' ? 0 : Math.min(500, summary.mistakes || 0),
          hints_used: mode === 'watch' ? 0 : Math.min(100, summary.hintsUsed || 0),
          source: 'extension',
          client_attempt_id: newAttemptId(),
        },
      })).catch(() => {});
    }

    function stopSession() {
      if (session) session.destroy();
      session = null;
    }

    async function startSession() {
      stopSession();
      const entry = reference.characters[characterIndex];
      position.textContent = `${entry.text}  ${characterIndex + 1} / ${reference.characters.length}`;
      prev.disabled = characterIndex <= 0;
      next.disabled = characterIndex >= reference.characters.length - 1;
      for (const item of MODES) {
        modeButtons[item].setAttribute('aria-pressed', String(item === mode));
        modeButtons[item].classList.toggle('lp-writing-mode-active', item === mode);
        modeButtons[item].disabled = !entry.supported;
      }
      tools.textContent = '';
      if (!entry.supported) {
        setStatus(t('writingUnsupported', 'There is no reviewed stroke data for this character yet.'));
        return;
      }
      setStatus(t('writingLoading', 'Loading strokes…'));
      const expected = { characterIndex, mode };
      try {
        await libraryLoader();
      } catch {
        if (!closed && expected.characterIndex === characterIndex && expected.mode === mode) showUnavailable();
        return;
      }
      if (closed || expected.characterIndex !== characterIndex || expected.mode !== mode) return;
      let watchedAll = false;
      session = createSession({
        element: surface,
        character: entry.text,
        mode,
        loadData: dataLoaderFor(runtime, entry),
        writerFactory,
        lifecycleDocument: doc,
        reducedMotion,
        callbacks: {
          onReady: () => { setStatus(readyText()); renderTools(); },
          onLoadError: () => showUnavailable(),
          onMistake: ({ isBackwards }) => setStatus(isBackwards
            ? t('writingBackwards', 'That stroke went the wrong way. Try it again in the shown direction.')
            : t('writingMistake', 'Not quite. Try that stroke again.')),
          onCorrectStroke: () => setStatus(readyText()),
          onStrokeCancelled: () => setStatus(t('writingStrokeCancelled', 'That stroke was interrupted. Draw it again.')),
          onComplete: (summary) => {
            setStatus(t('writingComplete', 'Well done. Try another step or the next character.'));
            record(entry, summary);
          },
          onWatchProgress: ({ shownStrokes, strokeCount }) => {
            if (!watchedAll && strokeCount && shownStrokes >= strokeCount) {
              watchedAll = true;
              record(entry, {});
            }
          },
        },
      });
      await session.ready;
    }

    function showUnavailable() {
      stopSession();
      tools.textContent = '';
      setStatus(t('writingUnavailable', 'Stroke data is unavailable right now.'));
      tools.appendChild(button(doc, 'lp-popup-listen', t('writingRetry', 'Retry'), () => { started = startSession(); }, registry));
    }

    function selectCharacter(index) {
      if (index < 0 || index >= reference.characters.length || index === characterIndex) return;
      characterIndex = index;
      mode = 'trace';
      started = startSession();
    }

    function selectMode(nextMode) {
      if (!MODES.includes(nextMode) || nextMode === mode) return;
      mode = nextMode;
      started = startSession();
    }

    registry.add(doc, 'keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose?.({ reason: 'escape' });
    }, true);
    // SPA navigation or a re-render can remove the word; close safely then.
    if (typeof MutationObserverImpl === 'function' && doc.body) {
      observer = new MutationObserverImpl(() => {
        if (!anchor || !anchor.isConnected) onClose?.({ reason: 'anchor_removed' });
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    }
    registry.add(view, 'pagehide', () => onClose?.({ reason: 'pagehide' }));

    started = startSession();

    return {
      element: panel,
      /** Resolves once the current character and step are ready (or unavailable). */
      get ready() { return started; },
      get drawing() { return !!(session && session.drawing); },
      get listenerCount() { return registry.size + (session ? session.listenerCount : 0) + (observer ? 1 : 0); },
      get mode() { return mode; },
      get characterIndex() { return characterIndex; },
      get session() { return session; },
      selectMode,
      selectCharacter,
      close() {
        if (closed) return;
        closed = true;
        stopSession();
        registry.removeAll();
        if (observer) observer.disconnect();
        observer = null;
        panel.remove();
      },
    };
  }

  return { eligibleReference, openPanel, createSession, createRegistry, createScopedRenderTarget, quizOptionsFor };
})();

globalThis.LangslyWritingPractice = LangslyWritingPractice;
