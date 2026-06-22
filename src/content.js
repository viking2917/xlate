// content.js
// Injects a floating "OCR + Translate" trigger button and an in-page
// sidebar onto Internet Archive book reader pages. The sidebar is
// docked to the right edge; dragging its resize handle both changes
// its own width AND pushes the underlying page content left (via a
// margin-right on <html>) so the sidebar never overlaps the book
// reader — it shares the viewport with it.

(function () {
  if (window.__iaTranslatorInjected) return;
  window.__iaTranslatorInjected = true;

  const DEFAULT_WIDTH = 380;
  const MIN_WIDTH = 280;
  const MAX_WIDTH_RATIO = 0.7; // never push the page content narrower than 30% of viewport


  // ---------- Build sidebar ----------
  const sidebar = document.createElement('div');
  sidebar.id = 'ia-translator-sidebar';
  sidebar.innerHTML = `
    <div id="ia-translator-resize-handle" title="Drag to resize"></div>
    <div id="ia-translator-header">
      <span id="ia-translator-title">Bookxlate OCR &amp; Translation</span>
      <div id="ia-translator-header-btns">
        <button id="ia-translator-trigger-2" title="Capture and Translate">📄</button>
        <button id="ia-translator-settings" title="Settings">⚙</button>
        <button id="ia-translator-close" title="Close">✕</button>
      </div>
    </div>
    <div id="ia-translator-body">
      <div id="ia-translator-status" class="ia-translator-empty">
        Click "OCR + Translate" to capture the current book page.
      </div>
      <div id="ia-translator-detected-lang" style="display:none;"></div>

      <details id="ia-translator-section-translation" class="ia-translator-collapsible" style="display:none;" open>
        <summary>English Translation</summary>
        <div id="ia-translator-translation-text" class="ia-translator-text  text-font"></div>
      </details>

      <details id="ia-translator-section-original" class="ia-translator-collapsible" style="display:none;" open>
        <summary>Original (OCR)</summary>
        <div id="ia-translator-original-text" class="ia-translator-text text-font"></div>
      </details>

      <details id="ia-translator-section-commentary" class="ia-translator-collapsible" style="display:none;">
        <summary>Commentary &amp; Historical Background</summary>
        <div id="ia-translator-commentary-text" class="ia-translator-text"></div>
      </details>

      <button id="ia-translator-add-btn" style="display:none;">+ Add to Collection</button>
    </div>
    <div id="ia-translator-collection-bar">
      <span id="ia-translator-collection-count">0 pages collected</span>
      <div id="ia-translator-collection-btns">
        <button id="ia-translator-view-collection">View</button>
        <button id="ia-translator-export-collection">Export .md</button>
        <button id="ia-translator-clear-collection">Clear</button>
      </div>
    </div>
    <div id="ia-translator-collection-panel" style="display:none;"></div>
  `;
  document.documentElement.appendChild(sidebar);

  const statusEl = sidebar.querySelector('#ia-translator-status');
  const langEl = sidebar.querySelector('#ia-translator-detected-lang');
  const origSection = sidebar.querySelector('#ia-translator-section-original');
  const origText = sidebar.querySelector('#ia-translator-original-text');
  const transSection = sidebar.querySelector('#ia-translator-section-translation');
  const transText = sidebar.querySelector('#ia-translator-translation-text');
  const commentarySection = sidebar.querySelector('#ia-translator-section-commentary');
  const commentaryText = sidebar.querySelector('#ia-translator-commentary-text');
  const addBtn = sidebar.querySelector('#ia-translator-add-btn');
  const collectionCount = sidebar.querySelector('#ia-translator-collection-count');
  const collectionPanel = sidebar.querySelector('#ia-translator-collection-panel');
  const viewBtn = sidebar.querySelector('#ia-translator-view-collection');
  const exportBtn = sidebar.querySelector('#ia-translator-export-collection');
  const clearBtn = sidebar.querySelector('#ia-translator-clear-collection');
  const resizeHandle = sidebar.querySelector('#ia-translator-resize-handle');
  const triggerBtn2 = sidebar.querySelector('#ia-translator-trigger-2');

  let lastResult = null;

  function injectTriggerButton() {
    // ---------- Build floating trigger button ----------
    const triggerBtn = document.createElement('button');
    triggerBtn.id = 'ia-translator-trigger';
    triggerBtn.textContent = 'OCR + Translate';
    triggerBtn.title = 'Capture this page and send it to Gemini for OCR + translation';

    let body = document.querySelector('body');
    // ensure body is positioned so injected elements can be placed relative to it
    try {
      body.style.position = body.style.position || 'relative';
    } catch (e) {
      // ignore if body not writable for some reason
    }

    triggerBtn.addEventListener('click', runCapture);
  
    // document.documentElement.appendChild(triggerBtn);
    body.appendChild(triggerBtn);

  }
  
  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.style.display = 'block';
    statusEl.className = isError ? 'ia-translator-error' : 'ia-translator-loading';
  }

  function setStatusWithAction(msg, actionLabel, onAction) {
    statusEl.innerHTML = '';
    statusEl.className = 'ia-translator-error';
    statusEl.style.display = 'block';

    const msgSpan = document.createElement('div');
    msgSpan.textContent = msg;
    statusEl.appendChild(msgSpan);

    const actionBtn = document.createElement('button');
    actionBtn.id = 'ia-translator-status-action';
    actionBtn.textContent = actionLabel;
    actionBtn.addEventListener('click', onAction);
    statusEl.appendChild(actionBtn);
  }

  function clearResults() {
    langEl.style.display = 'none';
    origSection.style.display = 'none';
    transSection.style.display = 'none';
    commentarySection.style.display = 'none';
    origText.textContent = '';
    transText.textContent = '';
    commentaryText.textContent = '';
    addBtn.style.display = 'none';
    lastResult = null;
  }

  // ---------- Open/close + page push ----------
  // Pushing margin-right on <html> (not <body>) sidesteps most sites'
  // own body margin/padding rules and reliably shifts the ENTIRE
  // rendered page — including any fixed/sticky header — left, so the
  // sidebar shares the viewport with the page instead of overlapping it.
  const htmlEl = document.documentElement;

  function applyPageShift(widthPx) {
    htmlEl.style.marginRight = `${widthPx}px`;
    htmlEl.style.transition = 'margin-right 0.2s ease';
  }

  function clearPageShift() {
    htmlEl.style.marginRight = '';
  }

  function openSidebar() {
    sidebar.classList.add('ia-translator-open');
    const width = sidebar.getBoundingClientRect().width;
    applyPageShift(width);
  }

  function closeSidebar() {
    sidebar.classList.remove('ia-translator-open');
    clearPageShift();
  }

  sidebar.querySelector('#ia-translator-close').addEventListener('click', closeSidebar);

  sidebar.querySelector('#ia-translator-settings').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
  });

  // ---------- Identify the book + current page (for collection grouping) ----------
  function getBookId() {
    const m = window.location.pathname.match(/\/details\/([^/]+)/);
    return m ? m[1] : window.location.pathname;
  }

  function getBookTitle() {
    const h1 = document.querySelector('h1.item-title, h1[itemprop="name"]');
    return (h1 && h1.textContent.trim()) || getBookId();
  }

  function getCurrentPageLabel() {
    const candidates = [
      document.querySelector('.BRcurrentpage'),
      document.querySelector('.BRnavCurrentPage'),
      document.querySelector('[class*="pagenum"]')
    ].filter(Boolean);
    for (const el of candidates) {
      const txt = el.textContent.trim();
      if (txt) return txt;
    }
    return null;
  }

  const storageKey = (bookId) => `ia_translator_collection__${bookId}`;

  async function getCollection() {
    const bookId = getBookId();
    const key = storageKey(bookId);
    const res = await chrome.storage.local.get([key]);
    return res[key] || [];
  }

  async function saveCollection(entries) {
    const bookId = getBookId();
    const key = storageKey(bookId);
    await chrome.storage.local.set({ [key]: entries });
  }

  async function refreshCollectionCount() {
    const entries = await getCollection();
    collectionCount.textContent = `${entries.length} page${
      entries.length === 1 ? '' : 's'
    } collected`;
    return entries;
  }

  // ---------- Find the book reader viewport to crop ----------
  function getCaptureRegion() {
    const reader =
      document.querySelector('#BookReader') ||
      document.querySelector('.BRcontainer') ||
      document.querySelector('#br-container');

    if (!reader) return null;
    const rect = reader.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) return null;
    return {
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: rect.width,
      height: rect.height,
      dpr: window.devicePixelRatio || 1
    };
  }

  async function runCapture() {
    clearResults();
    openSidebar();
    setStatus('Capturing page…');

    const region = getCaptureRegion();
    if (!region) {
      setStatus(
        'Could not find the book reader on this page. Make sure a book page is visible.',
        true
      );
      return;
    }

    chrome.runtime.sendMessage(
      { type: 'CAPTURE_AND_PROCESS', region },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatus('Error: ' + chrome.runtime.lastError.message, true);
          return;
        }
        if (!response || !response.ok) {
          const errMsg = response ? response.error : 'unknown error';
          if (response && response.code === 'NO_API_KEY') {
            setStatusWithAction('No Gemini API key set yet.', 'Open Settings', () =>
              chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' })
            );
          } else {
            setStatus('Error: ' + errMsg, true);
          }
          return;
        }

        const { detectedLanguage, isEnglish, ocrText, translation, commentary } =
          response.data;

        lastResult = { detectedLanguage, isEnglish, ocrText, translation, commentary };

        langEl.style.display = 'block';
        langEl.textContent = detectedLanguage
          ? `Detected language: ${detectedLanguage}`
          : '';

        origSection.style.display = 'block';
        origText.textContent = ocrText || '(no text found)';

        if (!isEnglish && translation) {
          transSection.style.display = 'block';
          transText.textContent = translation;
        }

        if (commentary) {
          commentarySection.style.display = 'block';
          commentaryText.textContent = commentary;
        }

        statusEl.style.display = 'none';
        addBtn.style.display = ocrText ? 'block' : 'none';
        addBtn.textContent = '+ Add to Collection';
        addBtn.disabled = false;
      }
    );
  }

  triggerBtn2.addEventListener('click', runCapture);

  addBtn.addEventListener('click', async () => {
    if (!lastResult) return;
    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';

    const entries = await getCollection();
    entries.push({
      pageLabel: getCurrentPageLabel() || `Capture #${entries.length + 1}`,
      detectedLanguage: lastResult.detectedLanguage,
      isEnglish: lastResult.isEnglish,
      ocrText: lastResult.ocrText,
      translation: lastResult.translation,
      commentary: lastResult.commentary,
      addedAt: new Date().toISOString()
    });
    await saveCollection(entries);
    await refreshCollectionCount();

    addBtn.textContent = '✓ Added';
    setTimeout(() => {
      if (lastResult) {
        addBtn.textContent = '+ Add to Collection';
        addBtn.disabled = false;
      }
    }, 1200);
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderCollectionPanel(entries) {
    if (entries.length === 0) {
      collectionPanel.innerHTML =
        '<div class="ia-translator-empty-collection">No pages collected yet for this book.</div>';
      return;
    }
    collectionPanel.innerHTML = entries
      .map((e, i) => {
        const lang = e.detectedLanguage || 'Unknown';
        const snippet = (e.ocrText || '').slice(0, 80).replace(/\n/g, ' ');
        return `
          <div class="ia-translator-collection-item" data-index="${i}">
            <div class="ia-translator-collection-item-head">
              <strong>${escapeHtml(e.pageLabel)}</strong>
              <span class="ia-translator-collection-item-lang">${escapeHtml(lang)}</span>
              <button class="ia-translator-remove-item" data-index="${i}" title="Remove">✕</button>
            </div>
            <div class="ia-translator-collection-item-snippet">${escapeHtml(snippet)}${
          (e.ocrText || '').length > 80 ? '…' : ''
        }</div>
          </div>
        `;
      })
      .join('');

    collectionPanel.querySelectorAll('.ia-translator-remove-item').forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        const current = await getCollection();
        current.splice(idx, 1);
        await saveCollection(current);
        const refreshed = await refreshCollectionCount();
        renderCollectionPanel(refreshed);
      });
    });
  }

  viewBtn.addEventListener('click', async () => {
    const isOpen = collectionPanel.style.display === 'block';
    if (isOpen) {
      collectionPanel.style.display = 'none';
      viewBtn.textContent = 'View';
      return;
    }
    const entries = await getCollection();
    renderCollectionPanel(entries);
    collectionPanel.style.display = 'block';
    viewBtn.textContent = 'Hide';
  });

  exportBtn.addEventListener('click', async () => {
    const entries = await getCollection();
    if (entries.length === 0) {
      setStatus('No pages collected yet — add some first.', true);
      openSidebar();
      return;
    }
    const md = buildMarkdown(getBookTitle(), getBookId(), entries);
    downloadMarkdown(md, getBookId());
  });

  clearBtn.addEventListener('click', async () => {
    const entries = await getCollection();
    if (entries.length === 0) return;
    const confirmed = window.confirm(
      `Remove all ${entries.length} collected page(s) for this book? This can't be undone.`
    );
    if (!confirmed) return;
    await saveCollection([]);
    const refreshed = await refreshCollectionCount();
    renderCollectionPanel(refreshed);
  });

  function buildMarkdown(title, bookId, entries) {
    const lines = [];
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(`*Source: https://archive.org/details/${bookId}*`);
    lines.push(`*Exported: ${new Date().toLocaleString()}*`);
    lines.push('');
    lines.push('---');
    lines.push('');

    entries.forEach((e) => {
      lines.push(`## ${e.pageLabel}`);
      lines.push('');
      if (e.detectedLanguage) {
        lines.push(`**Detected language:** ${e.detectedLanguage}`);
        lines.push('');
      }
      if (!e.isEnglish && e.translation) {
        lines.push('### English Translation');
        lines.push('');
        lines.push(e.translation);
        lines.push('');
      }
      lines.push('### Original (OCR)');
      lines.push('');
      lines.push(e.ocrText ? e.ocrText : '*(no text found)*');
      lines.push('');
      if (e.commentary) {
        lines.push('### Commentary & Historical Background');
        lines.push('');
        lines.push(e.commentary);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    });

    return lines.join('\n');
  }

  function downloadMarkdown(md, bookId) {
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${bookId}-ocr-translation.md`;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Initialize collection count on load
  refreshCollectionCount();

  // ---------- Resizable sidebar width (also pushes the page) ----------
  function getMaxWidth() {
    return Math.round(window.innerWidth * MAX_WIDTH_RATIO);
  }

  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

  async function loadSavedWidth() {
    const { sidebarWidth } = await chrome.storage.local.get(['sidebarWidth']);
    const width = clamp(sidebarWidth || DEFAULT_WIDTH, MIN_WIDTH, getMaxWidth());
    sidebar.style.width = `${width}px`;
  }

  let resizing = false;
  let startX = 0;
  let startWidth = 0;

  resizeHandle.addEventListener('mousedown', (e) => {
    resizing = true;
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    // Disable the CSS transition while actively dragging so the page
    // shift tracks the cursor 1:1 instead of lagging/animating.
    htmlEl.style.transition = 'none';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    // Sidebar is anchored to the right edge, so dragging left (negative dx)
    // should increase width.
    const dx = startX - e.clientX;
    const newWidth = clamp(startWidth + dx, MIN_WIDTH, getMaxWidth());
    sidebar.style.width = `${newWidth}px`;
    if (sidebar.classList.contains('ia-translator-open')) {
      htmlEl.style.marginRight = `${newWidth}px`;
    }
  });

  window.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.userSelect = '';
    htmlEl.style.transition = 'margin-right 0.2s ease';
    const finalWidth = Math.round(sidebar.getBoundingClientRect().width);
    chrome.storage.local.set({ sidebarWidth: finalWidth });
  });

  // Keep the max width sane if the browser window itself is resized.
  window.addEventListener('resize', () => {
    const maxW = getMaxWidth();
    const currentW = sidebar.getBoundingClientRect().width;
    if (currentW > maxW) {
      sidebar.style.width = `${maxW}px`;
      if (sidebar.classList.contains('ia-translator-open')) {
        htmlEl.style.marginRight = `${maxW}px`;
      }
    }
  });

  loadSavedWidth();

  // Listen for background telling us processing state (for long requests)
  chrome.runtime.onMessage.addListener((msg) => {

    // inject button if not already
    let btn = document.querySelector('ia-translator-trigger');
    if(!btn) {
      injectTriggerButton();
    }

    if (msg.type === 'PROCESSING_STATUS') {
      setStatus(msg.message);
    }
    if (msg.type === 'TRIGGER_CAPTURE') {
      runCapture();
    }
  });
})();
