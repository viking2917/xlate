// background.js
// MV3 service worker: handles tab screenshot capture, cropping to the
// reader region, and calling the Gemini API for OCR + translation.
// Results are returned directly to the content script's in-page
// sidebar via sendResponse — there is no separate panel window.

// One-time migration: an earlier version of this extension stored the
// API key in chrome.storage.sync. If a local key is missing but a sync
// key exists, copy it over so users don't have to re-enter it.
async function migrateLegacySyncKey() {
  try {
    const local = await chrome.storage.local.get(['geminiApiKey']);
    if (local.geminiApiKey) return; // already have a local key, nothing to do

    const sync = await chrome.storage.sync.get(['geminiApiKey', 'geminiModel']);
    if (sync.geminiApiKey) {
      await chrome.storage.local.set({
        geminiApiKey: sync.geminiApiKey,
        geminiModel: sync.geminiModel || 'gemini-2.5-flash'
      });
      console.log('Migrated Gemini API key from sync storage to local storage.');
    }
  } catch (e) {
    console.warn('Sync-to-local key migration skipped:', e);
  }
}

migrateLegacySyncKey();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (msg.type === 'CAPTURE_AND_PROCESS') {
    const tabId = sender.tab && sender.tab.id;
    handleCaptureAndProcess(msg.region, tabId)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err.message || String(err),
          code: err.code || null
        })
      );
    return true; // keep the message channel open for async sendResponse
  }
});

// Toolbar icon: shortcut for the in-page trigger button. Falls back to
// opening settings if the content script isn't reachable (e.g. wrong page).
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_CAPTURE' });
  } catch (e) {
    chrome.runtime.openOptionsPage();
  }
});

function notify(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'PROCESSING_STATUS', message }).catch(() => {});
}

async function handleCaptureAndProcess(region, tabId) {
  notify(tabId, 'Capturing screenshot…');
  const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });

  notify(tabId, 'Cropping image…');
  const croppedDataUrl = await cropImage(dataUrl, region);

  notify(tabId, 'Loading settings…');
  const { geminiApiKey, geminiModel } = await chrome.storage.local.get([
    'geminiApiKey',
    'geminiModel'
  ]);

  if (!geminiApiKey) {
    const err = new Error('No Gemini API key set yet.');
    err.code = 'NO_API_KEY';
    throw err;
  }

  notify(tabId, 'Sending to Gemini for OCR + translation…');
  const result = await callGemini(
    croppedDataUrl,
    geminiApiKey,
    geminiModel || 'gemini-2.5-flash'
  );

  return result;
}

// Crop a data URL image to the given CSS-pixel region using OffscreenCanvas.
async function cropImage(dataUrl, region) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const dpr = region.dpr || 1;
  const sx = Math.round(region.x * dpr);
  const sy = Math.round(region.y * dpr);
  const sw = Math.round(region.width * dpr);
  const sh = Math.round(region.height * dpr);

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  return await blobToDataUrl(outBlob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function callGemini(imageDataUrl, apiKey, model) {
  const base64 = imageDataUrl.split(',')[1];

  const prompt = `You are an OCR, translation, and literary/historical commentary assistant looking at a single page photographed/scanned from a book on the Internet Archive.

1. Transcribe ALL legible text on the page exactly as it appears (preserve line breaks where sensible, fix obvious OCR-only artifacts but don't paraphrase).
2. Identify the primary language of the text (e.g. "English", "Latin", "French", "Old French", etc).
3. If the language is NOT English, provide a faithful, readable English translation. If it IS English, leave the translation field empty.
4. Provide brief commentary or historical/literary background relevant to this passage — e.g. context about the author, period, subject matter, references, allusions, or terms a modern reader might not recognize. Keep it concise (a short paragraph or two). If there's genuinely nothing noteworthy to add (e.g. a blank or purely decorative page), leave it empty.

Respond ONLY with strict JSON, no markdown fences, no commentary outside the JSON, in exactly this shape:
{
  "detectedLanguage": "string",
  "isEnglish": boolean,
  "ocrText": "string",
  "translation": "string",
  "commentary": "string"
}

If the page has no legible text (e.g. blank page, cover art with no text), set ocrText to an empty string, isEnglish to true, and commentary to an empty string.`;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: 'image/png',
              data: base64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const json = await resp.json();
  const candidate = json.candidates && json.candidates[0];
  const textOut =
    candidate &&
    candidate.content &&
    candidate.content.parts &&
    candidate.content.parts.map((p) => p.text || '').join('');

  if (!textOut) {
    throw new Error('Gemini returned no text content. Try again.');
  }

  let parsed;
  try {
    parsed = JSON.parse(textOut);
  } catch (e) {
    // Fallback: try to strip stray markdown fences if the model added them anyway
    const cleaned = textOut.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  }

  return {
    detectedLanguage: parsed.detectedLanguage || '',
    isEnglish: !!parsed.isEnglish,
    ocrText: parsed.ocrText || '',
    translation: parsed.translation || '',
    commentary: parsed.commentary || ''
  };
}
