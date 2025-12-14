// PostHog Analytics - lightweight API-only implementation (no external scripts)
const posthog = (() => {
  const apiKey = 'phc_3Syrqboc8siQybuxs5VmqQ6WANwHsUIvbH8ILDIrRgX';
  const apiHost = 'https://eu.i.posthog.com';
  let distinctId = null;

  const getDistinctId = async () => {
    if (distinctId) return distinctId;
    const stored = await chrome.storage.local.get(['posthog_distinct_id']);
    if (stored.posthog_distinct_id) {
      distinctId = stored.posthog_distinct_id;
    } else {
      distinctId = 'ext_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
      await chrome.storage.local.set({ posthog_distinct_id: distinctId });
    }
    return distinctId;
  };

  return {
    capture: async (eventName, properties = {}) => {
      try {
        const id = await getDistinctId();
        await fetch(`${apiHost}/capture/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            event: eventName,
            properties: { ...properties, distinct_id: id, $lib: 'chrome-extension' },
            timestamp: new Date().toISOString()
          })
        });
      } catch (e) {
        console.debug('Analytics error:', e);
      }
    }
  };
})();

const queryInput = document.getElementById('query');
const queryLabel = document.getElementById('queryLabel');
const actionBtn = document.getElementById('actionBtn');
const clearBtn = document.getElementById('clear');
const status = document.getElementById('status');
const supportBtn = document.getElementById('supportBtn');
const settingsBtn = document.getElementById('settingsBtn');
const mainView = document.getElementById('mainView');
const supportView = document.getElementById('supportView');
const settingsView = document.getElementById('settingsView');
const supportBackBtn = document.getElementById('supportBackBtn');
const settingsBackBtn = document.getElementById('settingsBackBtn');
const providerBtns = document.querySelectorAll('.provider-btn');
const modelBtn = document.getElementById('modelBtn');
const modelLabel = document.getElementById('modelLabel');
const modelList = document.getElementById('modelList');
const modeBtns = document.querySelectorAll('.mode-btn');
const clearGroup = document.getElementById('clearGroup');

let selectedProvider = 'anthropic';
let selectedModel = 'claude-sonnet-4-5-20250929';

const DATA_URL = 'https://raw.githubusercontent.com/adi-family/database/main/app/adi-highlighter/v1.json';

// Chunking configuration
const CHUNK_SIZE = 8000;
const CHUNK_OVERLAP = 500;
const MAX_ITEMS_PER_CHUNK = 15;

// Retry and parallelization configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_CONCURRENT_CHUNKS = 3;

// Retry utility with exponential backoff
const withRetry = async (fn, { maxRetries = MAX_RETRIES, initialDelay = INITIAL_RETRY_DELAY_MS } = {}) => {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable = error.message?.includes('rate') ||
                          error.message?.includes('429') ||
                          error.message?.includes('timeout') ||
                          error.message?.includes('overloaded') ||
                          error.message?.includes('503') ||
                          error.message?.includes('500');

      if (attempt < maxRetries && isRetryable) {
        const delay = initialDelay * Math.pow(2, attempt);
        console.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms:`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else if (!isRetryable) {
        throw error; // Non-retryable error, fail immediately
      }
    }
  }
  throw lastError;
};

// Controlled parallel execution utility
const processWithConcurrency = async (items, fn, { concurrency = MAX_CONCURRENT_CHUNKS, onProgress } = {}) => {
  const results = new Array(items.length);
  let currentIndex = 0;
  let completedCount = 0;

  const worker = async () => {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      const item = items[index];
      try {
        results[index] = { success: true, value: await fn(item, index) };
      } catch (error) {
        results[index] = { success: false, error };
      }
      completedCount++;
      onProgress?.(completedCount, items.length);
    }
  };

  // Start workers up to concurrency limit
  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
};

// Chunk text using semantic boundaries (paragraphs) with sliding window fallback
const chunkText = (text) => {
  const chunks = [];

  // Split by paragraph boundaries (double newlines, or single with indent patterns)
  const paragraphs = text.split(/\n\s*\n|\n(?=\s{2,})/);

  let currentChunk = '';

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // If single paragraph exceeds chunk size, use sliding window
    if (trimmed.length > CHUNK_SIZE) {
      // Flush current chunk first
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // Sliding window for large paragraph
      let start = 0;
      while (start < trimmed.length) {
        const end = Math.min(start + CHUNK_SIZE, trimmed.length);
        chunks.push(trimmed.substring(start, end));
        start = end - CHUNK_OVERLAP;
        if (start + CHUNK_OVERLAP >= trimmed.length) break;
      }
      continue;
    }

    // Check if adding this paragraph exceeds chunk size
    const potentialChunk = currentChunk + (currentChunk ? '\n\n' : '') + trimmed;

    if (potentialChunk.length > CHUNK_SIZE) {
      // Save current chunk and start new one
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = trimmed;
    } else {
      currentChunk = potentialChunk;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text.substring(0, CHUNK_SIZE)];
};

// Deduplicate matches by text content
const deduplicateMatches = (matches) => {
  const seen = new Map();

  for (const match of matches) {
    const key = match.text.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.set(key, match);
    }
  }

  return Array.from(seen.values());
};
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

let MODELS_BY_PROVIDER = {};
let PROVIDERS_DATA = [];
let RECOMMENDED_MODELS = {};
let RECOMMENDED_SMARTEST = {};
let RECOMMENDED_CHEAPEST = {};
let RECOMMENDED_BALANCED = {};
let showAllModels = false;

const fetchModelData = async () => {
  const cached = await chrome.storage.local.get(['modelsCache', 'modelsCacheTime']);
  const now = Date.now();

  if (cached.modelsCache && cached.modelsCacheTime && (now - cached.modelsCacheTime < CACHE_DURATION_MS)) {
    return cached.modelsCache;
  }

  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error('Failed to fetch');
    const data = await response.json();
    await chrome.storage.local.set({ modelsCache: data, modelsCacheTime: now });
    return data;
  } catch (err) {
    console.error('Failed to fetch model data:', err);
    return cached.modelsCache || null;
  }
};

const buildModelsFromData = (data) => {
  if (!data?.models) return;

  PROVIDERS_DATA = data.providers || [];
  RECOMMENDED_MODELS = data.recommendedModel || {};
  MODELS_BY_PROVIDER = {};

  // Build provider -> model lookup for each category
  RECOMMENDED_SMARTEST = {};
  RECOMMENDED_CHEAPEST = {};
  RECOMMENDED_BALANCED = {};

  (data.recommendedSmartest || []).forEach(r => {
    RECOMMENDED_SMARTEST[r.provider] = r.model;
  });
  (data.recommendedCheapest || []).forEach(r => {
    RECOMMENDED_CHEAPEST[r.provider] = r.model;
  });
  (data.recommendedBalanced || []).forEach(r => {
    RECOMMENDED_BALANCED[r.provider] = r.model;
  });

  const cheapestSet = new Set((data.recommendedCheapest || []).map(r => `${r.provider}:${r.model}`));
  const smartestSet = new Set((data.recommendedSmartest || []).map(r => `${r.provider}:${r.model}`));
  const balancedSet = new Set((data.recommendedBalanced || []).map(r => `${r.provider}:${r.model}`));

  data.models.forEach(m => {
    const provider = m.provider;
    if (!MODELS_BY_PROVIDER[provider]) {
      MODELS_BY_PROVIDER[provider] = [];
    }

    const modelKey = `${provider}:${m.model}`;
    let tagLabel = '';
    if (smartestSet.has(modelKey)) tagLabel = 'smartest';
    else if (balancedSet.has(modelKey)) tagLabel = 'balanced';
    else if (cheapestSet.has(modelKey)) tagLabel = 'cheapest';

    MODELS_BY_PROVIDER[provider].push({
      value: m.model,
      label: m.model,
      tagLabel,
      inputPrice: m.inputPricePerMtok,
      outputPrice: m.outputPricePerMtok,
      contextWindow: m.contextWindow,
      tags: m.tags
    });
  });
};

const getCategoryModel = (category, provider) => {
  const lookup = {
    smartest: RECOMMENDED_SMARTEST,
    balanced: RECOMMENDED_BALANCED,
    cheapest: RECOMMENDED_CHEAPEST
  };
  return lookup[category]?.[provider];
};

const getCategoryForModel = (model, provider) => {
  if (RECOMMENDED_SMARTEST[provider] === model) return 'smartest';
  if (RECOMMENDED_BALANCED[provider] === model) return 'balanced';
  if (RECOMMENDED_CHEAPEST[provider] === model) return 'cheapest';
  return null;
};

const getModelPricing = (provider, model) => {
  const models = MODELS_BY_PROVIDER[provider] || [];
  const found = models.find(m => m.value === model);
  return found ? { inputPrice: found.inputPrice, outputPrice: found.outputPrice } : null;
};

const calculateCost = (inputTokens, outputTokens, pricing) => {
  if (!pricing || !pricing.inputPrice || !pricing.outputPrice) return null;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPrice;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPrice;
  return inputCost + outputCost;
};

const formatCost = (cost) => {
  if (cost === null || cost === undefined) return '';
  if (cost < 0.0001) return `$${cost.toExponential(2)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
};

const getDisplayLabel = (model, category) => {
  if (category) {
    const categoryLabels = { smartest: 'Smartest', balanced: 'Balanced', cheapest: 'Cheapest' };
    return categoryLabels[category] + ' - ' + model;
  }
  return model;
};

const populateModels = (provider, model) => {
  const models = MODELS_BY_PROVIDER[provider] || [];
  modelList.innerHTML = '';
  showAllModels = false;

  const categories = [
    { key: 'smartest', label: 'Smartest' },
    { key: 'balanced', label: 'Balanced' },
    { key: 'cheapest', label: 'Cheapest' }
  ];

  // Add category options
  categories.forEach(cat => {
    const catModel = getCategoryModel(cat.key, provider);
    if (!catModel) return;

    const btn = document.createElement('button');
    const isSelected = selectedModel === catModel;
    btn.className = 'model-option' + (isSelected ? ' selected' : '');
    btn.textContent = cat.label;
    btn.dataset.value = catModel;
    btn.dataset.category = cat.key;
    btn.addEventListener('click', () => selectModel(catModel, getDisplayLabel(catModel, cat.key)));
    modelList.appendChild(btn);
  });

  // Add "Show all" option
  const showAllBtn = document.createElement('button');
  showAllBtn.className = 'model-option show-all';
  showAllBtn.textContent = 'Show all';
  showAllBtn.addEventListener('click', () => expandAllModels(provider));
  modelList.appendChild(showAllBtn);

  // Set initial selection
  if (model && models.some(m => m.value === model)) {
    selectedModel = model;
    const category = getCategoryForModel(model, provider);
    modelLabel.textContent = getDisplayLabel(model, category);
  } else {
    // Default to balanced, then first available category
    const defaultCategory = RECOMMENDED_BALANCED[provider] ? 'balanced' :
      RECOMMENDED_SMARTEST[provider] ? 'smartest' :
      RECOMMENDED_CHEAPEST[provider] ? 'cheapest' : null;

    if (defaultCategory) {
      selectedModel = getCategoryModel(defaultCategory, provider);
      modelLabel.textContent = getDisplayLabel(selectedModel, defaultCategory);
    } else if (models.length > 0) {
      selectedModel = models[0].value;
      modelLabel.textContent = models[0].label;
    }
  }

  updateModelSelection();
};

const expandAllModels = (provider) => {
  const models = MODELS_BY_PROVIDER[provider] || [];
  modelList.innerHTML = '';
  showAllModels = true;

  models.forEach(m => {
    const btn = document.createElement('button');
    const displayLabel = m.tagLabel ? m.label + ' - ' + m.tagLabel : m.label;
    btn.className = 'model-option' + (m.value === selectedModel ? ' selected' : '');
    btn.textContent = displayLabel;
    btn.dataset.value = m.value;
    btn.addEventListener('click', () => {
      const category = getCategoryForModel(m.value, provider);
      selectModel(m.value, getDisplayLabel(m.value, category));
    });
    modelList.appendChild(btn);
  });

  updateModelSelection();
};

const selectModel = (value, label) => {
  selectedModel = value;
  modelLabel.textContent = label;
  chrome.storage.local.set({ selectedModel: value });
  modelList.classList.remove('visible');
  modelBtn.classList.remove('open');
  updateModelSelection();
  posthog.capture('AI Model Selected', { provider: selectedProvider, model: value });
};

const updateModelSelection = () => {
  modelList.querySelectorAll('.model-option').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.value === selectedModel);
  });
};

const toggleModelList = () => {
  modelList.classList.toggle('visible');
  modelBtn.classList.toggle('open');
};

const applyRecommendedModel = (mode) => {
  const modeKey = mode === 'highlight' ? 'highlight' : 'extraction';
  const recommendations = RECOMMENDED_MODELS[modeKey];
  if (!recommendations?.length) return;

  const rec = recommendations[0];
  if (!rec?.provider || !rec?.model) return;

  const models = MODELS_BY_PROVIDER[rec.provider] || [];
  const found = models.find(m => m.value === rec.model);
  if (!found) return;

  selectedProvider = rec.provider;
  providerBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.provider === rec.provider);
  });
  chrome.storage.local.set({ selectedProvider: rec.provider });

  populateModels(rec.provider, rec.model);
  chrome.storage.local.set({ selectedModel: rec.model });
};

modelBtn.addEventListener('click', toggleModelList);

// Settings inputs
const openaiKey = document.getElementById('openaiKey');
const anthropicKey = document.getElementById('anthropicKey');
const geminiKey = document.getElementById('geminiKey');
const openaiStatus = document.getElementById('openaiStatus');
const anthropicStatus = document.getElementById('anthropicStatus');
const geminiStatus = document.getElementById('geminiStatus');
const openaiLogo = document.getElementById('openaiLogo');
const anthropicLogo = document.getElementById('anthropicLogo');
const geminiLogo = document.getElementById('geminiLogo');

let currentMode = 'highlight';

const updateKeyStatus = (statusEl, logoEl, hasKey) => {
  statusEl.textContent = hasKey ? 'configured' : 'not set';
  statusEl.className = hasKey ? 'key-status configured' : 'key-status missing';
  if (logoEl) {
    logoEl.classList.toggle('configured', hasKey);
  }
};

const updateProviderKeyStatus = async () => {
  const keys = await chrome.storage.local.get(['openaiKey', 'anthropicKey', 'geminiKey']);
  const keyMap = {
    openai: !!keys.openaiKey,
    anthropic: !!keys.anthropicKey,
    google: !!keys.geminiKey
  };

  providerBtns.forEach(btn => {
    const provider = btn.dataset.provider;
    btn.classList.toggle('no-key', !keyMap[provider]);
  });

  return keyMap;
};

const updateActionButtonState = async () => {
  const keys = await chrome.storage.local.get(['openaiKey', 'anthropicKey', 'geminiKey']);
  const keyMap = {
    openai: keys.openaiKey,
    anthropic: keys.anthropicKey,
    google: keys.geminiKey
  };
  const hasKey = !!keyMap[selectedProvider];
  actionBtn.disabled = !hasKey;
  actionBtn.title = hasKey ? '' : 'API key required - click Settings to configure';

  if (!hasKey) {
    status.innerHTML = '<a href="#" class="status-link" id="enterKeyLink">Enter API key</a> to use this provider';
    status.className = 'status';
    document.getElementById('enterKeyLink').addEventListener('click', (e) => {
      e.preventDefault();
      posthog.capture('Navigation', { to: 'Settings View', from: 'Missing Key Link' });
      mainView.classList.add('hidden');
      settingsView.classList.add('visible');
    });
  } else if (status.querySelector('.status-link')) {
    status.textContent = '';
    status.className = 'status';
  }
};

// Initialize: fetch model data then load settings
(async () => {
  const modelData = await fetchModelData();
  buildModelsFromData(modelData);

  chrome.storage.local.get(['openaiKey', 'anthropicKey', 'geminiKey', 'selectedProvider', 'selectedModel', 'lastQuery'], (result) => {
    if (result.openaiKey) openaiKey.value = result.openaiKey;
    if (result.anthropicKey) anthropicKey.value = result.anthropicKey;
    if (result.geminiKey) geminiKey.value = result.geminiKey;
    if (result.lastQuery) queryInput.value = result.lastQuery;

    updateKeyStatus(openaiStatus, openaiLogo, !!result.openaiKey);
    updateKeyStatus(anthropicStatus, anthropicLogo, !!result.anthropicKey);
    updateKeyStatus(geminiStatus, geminiLogo, !!result.geminiKey);
    updateProviderKeyStatus();
    updateActionButtonState();

    // Use saved provider/model or apply recommended for current mode
    if (result.selectedProvider && result.selectedModel) {
      selectedProvider = result.selectedProvider;
      providerBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.provider === result.selectedProvider);
      });
      populateModels(result.selectedProvider, result.selectedModel);
    } else if (Object.keys(RECOMMENDED_MODELS).length > 0) {
      applyRecommendedModel(currentMode);
    } else if (Object.keys(MODELS_BY_PROVIDER).length > 0) {
      const firstProvider = Object.keys(MODELS_BY_PROVIDER)[0];
      selectedProvider = firstProvider;
      providerBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.provider === firstProvider);
      });
      populateModels(firstProvider);
    }
  });
})();

// Save query input on change
queryInput.addEventListener('input', () => {
  chrome.storage.local.set({ lastQuery: queryInput.value });
});

// Save API keys on change
openaiKey.addEventListener('change', () => {
  chrome.storage.local.set({ openaiKey: openaiKey.value });
  updateKeyStatus(openaiStatus, openaiLogo, !!openaiKey.value);
  updateProviderKeyStatus();
  updateActionButtonState();
  posthog.capture('API Key Configured', { provider: 'openai', hasKey: !!openaiKey.value });
});
anthropicKey.addEventListener('change', () => {
  chrome.storage.local.set({ anthropicKey: anthropicKey.value });
  updateKeyStatus(anthropicStatus, anthropicLogo, !!anthropicKey.value);
  updateProviderKeyStatus();
  updateActionButtonState();
  posthog.capture('API Key Configured', { provider: 'anthropic', hasKey: !!anthropicKey.value });
});
geminiKey.addEventListener('change', () => {
  chrome.storage.local.set({ geminiKey: geminiKey.value });
  updateKeyStatus(geminiStatus, geminiLogo, !!geminiKey.value);
  updateProviderKeyStatus();
  updateActionButtonState();
  posthog.capture('API Key Configured', { provider: 'google', hasKey: !!geminiKey.value });
});

// Reset cache button
document.getElementById('resetCacheBtn').addEventListener('click', async () => {
  await chrome.storage.local.remove(['modelsCache', 'modelsCacheTime']);
  const modelData = await fetchModelData();
  buildModelsFromData(modelData);
  populateModels(selectedProvider);
  posthog.capture('Reset Cache');
});

// Save provider preference and repopulate models
providerBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    providerBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedProvider = btn.dataset.provider;
    chrome.storage.local.set({ selectedProvider });
    populateModels(selectedProvider);
    chrome.storage.local.set({ selectedModel });
    modelList.classList.remove('visible');
    modelBtn.classList.remove('open');
    updateActionButtonState();
    posthog.capture('AI Provider Selected', { provider: selectedProvider });
  });
});

// Mode switching
modeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    modeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = btn.dataset.mode;
    posthog.capture('Mode Changed', { mode: currentMode });

    if (currentMode === 'highlight') {
      queryLabel.textContent = 'What are you interested in?';
      queryInput.placeholder = "e.g., 'pricing info', 'technical specs', 'contact details'";
      actionBtn.textContent = 'Find';
    } else {
      queryLabel.textContent = 'What to extract';
      queryInput.placeholder = "e.g., 'all product names and prices as JSON', 'email addresses'";
      actionBtn.textContent = 'Extract';
      clearGroup.style.display = 'none';
    }

    applyRecommendedModel(currentMode);
  });
});

// Show support view
supportBtn.addEventListener('click', () => {
  posthog.capture('Navigation', { to: 'Support View' });
  mainView.classList.add('hidden');
  supportView.classList.add('visible');
});

// Show settings view
settingsBtn.addEventListener('click', () => {
  posthog.capture('Navigation', { to: 'Settings View' });
  mainView.classList.add('hidden');
  settingsView.classList.add('visible');
});

// Back to main view from support
supportBackBtn.addEventListener('click', () => {
  posthog.capture('Navigation', { from: 'Support View', to: 'Main View' });
  mainView.classList.remove('hidden');
  supportView.classList.remove('visible');
});

// Back to main view from settings
settingsBackBtn.addEventListener('click', () => {
  posthog.capture('Navigation', { from: 'Settings View', to: 'Main View' });
  mainView.classList.remove('hidden');
  settingsView.classList.remove('visible');
});

actionBtn.addEventListener('click', async () => {
  const query = queryInput.value.trim();

  if (!query) {
    status.textContent = `Please enter what to ${currentMode}`;
    return;
  }

  const provider = selectedProvider;
  const model = selectedModel; // Capture selected model for tracking
  const apiKey = await getApiKey(provider);

  if (!apiKey) {
    status.textContent = `Please configure ${provider} key in Settings`;
    status.className = 'status error';
    return;
  }

  posthog.capture('Action Started', {
    mode: currentMode,
    provider: provider,
    model: model,
    query: query.substring(0, 200) // Limit query length for tracking
  });

  actionBtn.disabled = true;
  status.textContent = currentMode === 'highlight' ? 'Analyzing page...' : 'Generating extraction code...';
  status.className = 'status';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let resultCost = 0; // Initialize cost variable

    if (currentMode === 'highlight') {
      const result = await performHighlight(tab, apiKey, query);
      resultCost = result.cost || 0;
    } else {
      const result = await performExtract(tab, apiKey, query);
      resultCost = result.cost || 0;
    }

    posthog.capture('Action Completed', {
      mode: currentMode,
      provider: provider,
      model: model,
      query: query.substring(0, 200),
      cost: resultCost
    });

    if (resultCost > 0) {
        posthog.capture('AI Call Cost', {
            provider: provider,
            model: model,
            cost: resultCost
        });
    }

  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.className = 'status error';
    posthog.capture('Action Failed', {
      mode: currentMode,
      provider: provider,
      model: model,
      query: query.substring(0, 200),
      error: err.message
    });
  }

  actionBtn.disabled = false;
});

clearBtn.addEventListener('click', async () => {
  posthog.capture('Clear Highlights');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      document.querySelectorAll('.ai-highlighter-mark').forEach(el => {
        el.outerHTML = el.innerHTML;
      });
      const bar = document.querySelector('.ai-highlighter-bar');
      if (bar) bar.remove();
    }
  });
  status.textContent = 'Cleared';
  status.className = 'status';
  clearGroup.style.display = 'none';
});

async function getApiKey(provider) {
  const keys = await chrome.storage.local.get(['openaiKey', 'anthropicKey', 'geminiKey']);
  const keyMap = {
    openai: keys.openaiKey,
    anthropic: keys.anthropicKey,
    google: keys.geminiKey
  };
  return keyMap[provider];
}

async function performHighlight(tab, apiKey, query) {
  const [{ result: pageText }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.body.innerText
  });

  const result = await findMatches(apiKey, query, pageText);
  const matches = result.matches;
  const totalCost = result.cost || 0; // Capture total cost from findMatches

  if (matches.length === 0) {
    const costStr = totalCost > 0 ? ` (${formatCost(totalCost)})` : '';
    status.textContent = `Nothing relevant found${costStr}`;
    status.className = 'status';
    return { cost: totalCost }; // Return cost even if no matches
  }

  // Count by type
  const typeCounts = matches.reduce((acc, m) => {
    acc[m.type] = (acc[m.type] || 0) + 1;
    return acc;
  }, {});

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: highlightOnPage,
    args: [matches]
  });

  // Inject the control bar
  const barResult = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: injectControlBar
  });
  console.log('Control bar injection result:', barResult);

  // Build status message
  const parts = [];
  if (typeCounts.word) parts.push(`${typeCounts.word} word${typeCounts.word > 1 ? 's' : ''}`);
  if (typeCounts.sentence) parts.push(`${typeCounts.sentence} sentence${typeCounts.sentence > 1 ? 's' : ''}`);
  if (typeCounts.content) parts.push(`${typeCounts.content} block${typeCounts.content > 1 ? 's' : ''}`);

  const costStr = totalCost > 0 ? ` (${formatCost(totalCost)})` : '';
  status.textContent = `Found ${parts.join(', ')}${costStr}`;
  status.className = 'status success';
  clearGroup.style.display = 'flex';

  return { cost: totalCost }; // Return the total cost
}

async function performExtract(tab, apiKey, query) {
  const [{ result: pageHtml }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.body.innerHTML.substring(0, 30000)
  });

  status.textContent = 'Asking AI for extraction code...';

  const extractionResult = await getExtractionCode(apiKey, query, pageHtml);
  const totalCost = extractionResult.cost || 0; // Capture total cost from getExtractionCode

  status.textContent = 'Running extraction...';

  const [{ result: extractedData }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (code) => {
      try {
        const fn = new Function(code);
        return fn();
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [extractionResult.code]
  });

  if (extractedData?.error) {
    status.textContent = 'Extraction error: ' + extractedData.error;
    status.className = 'status error';
    return { cost: totalCost }; // Return cost even on error
  }

  // Copy to clipboard
  const jsonStr = JSON.stringify(extractedData, null, 2);
  await navigator.clipboard.writeText(jsonStr);

  const costStr = totalCost !== null ? ` (${formatCost(totalCost)})` : '';
  status.textContent = `Extracted! Copied to clipboard${costStr}`;
  status.className = 'status success';

  console.log('Extracted data:', extractedData);
  return { cost: totalCost }; // Return the total cost
}

async function getExtractionCode(apiKey, query, pageHtml) {
  const provider = selectedProvider;
  const model = selectedModel;

  const systemPrompt = `You are a JavaScript code generator. The user wants to extract data from a webpage.
Generate JavaScript code that extracts the requested data and returns it.
The code will be executed in the page context via new Function().
Return ONLY the JavaScript code, no markdown, no explanation.
The code must return the extracted data (use return statement).
Example output for "extract all links":
const links = Array.from(document.querySelectorAll('a')).map(a => ({text: a.textContent.trim(), href: a.href}));
return links;`;

  const userPrompt = `Extract: "${query}"

Page HTML (truncated):
${pageHtml}`;

  const result = await callAI(provider, model, apiKey, systemPrompt, userPrompt);

  // Clean up the response
  let code = result.content
    .replace(/^```(?:javascript|js)?\s*/i, '')
    .replace(/\s*```$/g, '')
    .trim();

  return { code, cost: result.cost, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

async function callAI(provider, model, apiKey, systemPrompt, userPrompt) {
  const result = await withRetry(async () => {
    if (provider === 'openai') {
      return await callOpenAI(model, apiKey, systemPrompt, userPrompt);
    } else if (provider === 'anthropic') {
      return await callAnthropic(model, apiKey, systemPrompt, userPrompt);
    } else if (provider === 'google') {
      return await callGemini(model, apiKey, systemPrompt, userPrompt);
    } else {
      throw new Error('Unknown provider: ' + provider);
    }
  });

  const pricing = getModelPricing(provider, model);
  const cost = calculateCost(result.inputTokens || 0, result.outputTokens || 0, pricing);

  return {
    content: result.content,
    inputTokens: result.inputTokens || 0,
    outputTokens: result.outputTokens || 0,
    cost
  };
}

async function callOpenAI(model, apiKey, systemPrompt, userPrompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return {
    content: data.choices[0].message.content,
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0
  };
}

async function callAnthropic(model, apiKey, systemPrompt, userPrompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt }
      ]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return {
    content: data.content[0].text,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0
  };
}

async function callGemini(model, apiKey, systemPrompt, userPrompt) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: systemPrompt + '\n\n' + userPrompt }]
      }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return {
    content: data.candidates[0].content.parts[0].text,
    inputTokens: data.usageMetadata?.promptTokenCount || 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount || 0
  };
}

async function findMatches(apiKey, query, pageText) {
  const provider = selectedProvider;
  const model = selectedModel;

  const systemPrompt = `You analyze text to find content relevant to a user's interest. User is interested in: "${query}".

Your task: Find text segments that match their interest. Return EXACT text from the provided content.

Return JSON with "matches" array. Each match has:
- "text": the exact verbatim text from the page (must exist exactly as written)
- "type": one of "word" (single term/phrase), "sentence" (complete sentence), or "content" (multi-sentence block)

Guidelines:
- For specific terms/names/numbers: use "word" type
- For standalone facts/statements: use "sentence" type
- For explanations/descriptions spanning multiple sentences: use "content" type
- Only include genuinely relevant matches
- Max ${MAX_ITEMS_PER_CHUNK} items per response
- Text must be EXACT - copy verbatim from the content

Example response:
{"matches": [
  {"text": "$299", "type": "word"},
  {"text": "The product ships within 3-5 business days.", "type": "sentence"},
  {"text": "Our premium plan includes unlimited storage, priority support, and advanced analytics. Perfect for growing teams.", "type": "content"}
]}`;

  // Chunk the text and process each chunk
  const chunks = chunkText(pageText);
  console.log(`Processing ${chunks.length} chunks with concurrency ${MAX_CONCURRENT_CHUNKS}`);

  const allMatches = [];
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Process chunks in parallel with controlled concurrency
  const results = await processWithConcurrency(
    chunks,
    async (chunk, index) => {
      const result = await callAI(provider, model, apiKey, systemPrompt, chunk);

      let content = result.content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/g, '')
        .trim();

      const parsed = JSON.parse(content);
      const matches = parsed.matches || parsed.items || [];

      // Normalize old format (string array) to new format
      const normalizedMatches = matches.map(m => {
        if (typeof m === 'string') {
          return { text: m, type: 'sentence' };
        }
        return { text: m.text, type: m.type || 'sentence' };
      });

      console.log(`Chunk ${index + 1}: found ${normalizedMatches.length} matches`);
      return { matches: normalizedMatches, cost: result.cost, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    },
    {
      concurrency: MAX_CONCURRENT_CHUNKS,
      onProgress: (completed, total) => {
        status.textContent = `Analyzing chunks ${completed}/${total}...`;
      }
    }
  );

  // Aggregate results
  for (const result of results) {
    if (result.success) {
      allMatches.push(...result.value.matches);
      if (result.value.cost !== null) totalCost += result.value.cost;
      totalInputTokens += result.value.inputTokens;
      totalOutputTokens += result.value.outputTokens;
    } else {
      console.error('Chunk processing failed:', result.error);
    }
  }

  // Deduplicate and return
  const dedupedMatches = deduplicateMatches(allMatches);
  console.log(`Total unique matches: ${dedupedMatches.length}`);

  return {
    matches: dedupedMatches,
    cost: totalCost,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens
  };
}

function highlightOnPage(matches) {
  if (!matches || matches.length === 0) return;

  const findAndHighlight = (searchText, matchType) => {
    if (!searchText || searchText.length < 2) return false;

    const treeWalker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );

    let found = false;
    const nodesToProcess = [];

    while (treeWalker.nextNode()) {
      const node = treeWalker.currentNode;
      const text = node.textContent;

      let idx = text.indexOf(searchText);
      if (idx === -1) {
        idx = text.toLowerCase().indexOf(searchText.toLowerCase());
      }

      if (idx !== -1) {
        nodesToProcess.push({ node, idx, len: searchText.length, type: matchType });
        found = true;
      }
    }

    nodesToProcess.reverse().forEach(({ node, idx, len, type }) => {
      try {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + len);

        const mark = document.createElement('mark');
        mark.className = `ai-highlighter-mark ai-highlighter-${type || 'sentence'}`;
        mark.dataset.type = type || 'sentence';
        range.surroundContents(mark);
      } catch (e) {
        console.log('Highlight fallback for:', searchText);
      }
    });

    return found;
  };

  let totalFound = 0;
  matches.forEach(match => {
    // Handle both old format (string) and new format (object with text/type)
    const searchText = typeof match === 'string' ? match : match.text;
    const matchType = typeof match === 'string' ? 'sentence' : (match.type || 'sentence');

    const found = findAndHighlight(searchText, matchType);
    if (found) totalFound++;
    console.log(`Searching for "${searchText}" (${matchType}): ${found ? 'FOUND' : 'NOT FOUND'}`);
  });
  console.log(`Total highlighted: ${totalFound}/${matches.length}`);
}

function injectControlBar() {
  console.log('injectControlBar called');

  // Remove existing bar if present
  const existingBar = document.querySelector('.ai-highlighter-bar');
  if (existingBar) existingBar.remove();

  const allHighlights = document.querySelectorAll('.ai-highlighter-mark');
  console.log('Found highlights:', allHighlights.length);
  if (allHighlights.length === 0) return;

  // Count by type
  const typeCounts = { word: 0, sentence: 0, content: 0 };
  allHighlights.forEach(h => {
    const type = h.dataset.type || 'sentence';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });

  // State
  let currentIndex = 0;
  let activeFilter = 'all';

  const getFilteredHighlights = () => {
    if (activeFilter === 'all') return Array.from(allHighlights);
    return Array.from(allHighlights).filter(h => h.dataset.type === activeFilter);
  };

  // Build filter buttons HTML
  const filterBtns = [];
  filterBtns.push(`<button class="ai-highlighter-mode-btn active" data-filter="all">All</button>`);
  if (typeCounts.word > 0) filterBtns.push(`<button class="ai-highlighter-mode-btn" data-filter="word">W:${typeCounts.word}</button>`);
  if (typeCounts.sentence > 0) filterBtns.push(`<button class="ai-highlighter-mode-btn" data-filter="sentence">S:${typeCounts.sentence}</button>`);
  if (typeCounts.content > 0) filterBtns.push(`<button class="ai-highlighter-mode-btn" data-filter="content">C:${typeCounts.content}</button>`);

  // Create bar HTML
  const bar = document.createElement('div');
  bar.className = 'ai-highlighter-bar';
  bar.innerHTML = `
    <div class="ai-highlighter-nav">
      <button class="ai-highlighter-nav-btn" data-dir="prev">▲</button>
      <span class="ai-highlighter-counter">1 of ${allHighlights.length}</span>
      <button class="ai-highlighter-nav-btn" data-dir="next">▼</button>
    </div>
    <div class="ai-highlighter-mode">
      ${filterBtns.join('')}
    </div>
    <button class="ai-highlighter-close">✕</button>
  `;

  const counter = bar.querySelector('.ai-highlighter-counter');
  const modeBtns = bar.querySelectorAll('.ai-highlighter-mode-btn');

  const updateCounter = () => {
    const filtered = getFilteredHighlights();
    counter.textContent = `${currentIndex + 1} of ${filtered.length}`;
  };

  const clearActive = () => {
    allHighlights.forEach(h => h.classList.remove('active'));
  };

  const goToHighlight = (index) => {
    const filtered = getFilteredHighlights();
    if (filtered.length === 0) return;

    // Wrap around
    if (index < 0) index = filtered.length - 1;
    if (index >= filtered.length) index = 0;

    currentIndex = index;
    clearActive();

    const target = filtered[currentIndex];
    target.classList.add('active');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateCounter();
  };

  // Navigation handlers
  bar.querySelectorAll('.ai-highlighter-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.dir;
      goToHighlight(dir === 'next' ? currentIndex + 1 : currentIndex - 1);
    });
  });

  // Filter toggle handlers
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      currentIndex = 0;
      console.log('Filter:', activeFilter);
      goToHighlight(0);
    });
  });

  // Close handler
  bar.querySelector('.ai-highlighter-close').addEventListener('click', () => {
    allHighlights.forEach(el => {
      el.outerHTML = el.innerHTML;
    });
    bar.remove();
  });

  document.body.appendChild(bar);
  console.log('Control bar appended to body');

  // Go to first highlight
  goToHighlight(0);
}
