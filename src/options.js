// options.js

const apiKeyEl = document.getElementById('apiKey');
const modelEl = document.getElementById('model');
const saveBtn = document.getElementById('save');
const statusEl = document.getElementById('status');

async function load() {
  try {
    const { geminiApiKey, geminiModel } = await chrome.storage.local.get([
      'geminiApiKey',
      'geminiModel'
    ]);
    if (geminiApiKey) apiKeyEl.value = geminiApiKey;
    if (geminiModel) modelEl.value = geminiModel;
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

saveBtn.addEventListener('click', async () => {
  const key = apiKeyEl.value.trim();

  if (!key) {
    statusEl.textContent = 'Please enter an API key before saving.';
    statusEl.style.color = '#92201f';
    statusEl.style.display = 'block';
    return;
  }

  try {
    await chrome.storage.local.set({
      geminiApiKey: key,
      geminiModel: modelEl.value
    });

    // Verify the write actually landed, rather than trusting set() didn't throw.
    const check = await chrome.storage.local.get(['geminiApiKey']);
    if (check.geminiApiKey !== key) {
      throw new Error('Verification read did not match what was saved.');
    }

    statusEl.textContent = 'Saved ✓';
    statusEl.style.color = '#1d8f3f';
    statusEl.style.display = 'block';
    setTimeout(() => (statusEl.style.display = 'none'), 2000);
  } catch (e) {
    console.error('Failed to save settings:', e);
    statusEl.textContent = 'Failed to save: ' + (e.message || e);
    statusEl.style.color = '#92201f';
    statusEl.style.display = 'block';
  }
});

load();
