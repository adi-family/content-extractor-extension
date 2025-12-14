const apiKeyInput = document.getElementById('apiKey');
const queryInput = document.getElementById('query');
const highlightBtn = document.getElementById('highlight');
const clearBtn = document.getElementById('clear');
const status = document.getElementById('status');
const supportBtn = document.getElementById('supportBtn');
const supportIframe = document.getElementById('supportIframe');

// Load saved API key
chrome.storage.local.get(['apiKey'], (result) => {
  if (result.apiKey) apiKeyInput.value = result.apiKey;
});

// Save API key on change
apiKeyInput.addEventListener('change', () => {
  chrome.storage.local.set({ apiKey: apiKeyInput.value });
});

// Toggle support iframe
supportBtn.addEventListener('click', () => {
  supportIframe.classList.toggle('visible');
});

highlightBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  const query = queryInput.value.trim();

  if (!apiKey) {
    status.textContent = 'Please enter API key';
    return;
  }
  if (!query) {
    status.textContent = 'Please enter what to highlight';
    return;
  }

  highlightBtn.disabled = true;
  status.textContent = 'Analyzing page...';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Get page text
    const [{ result: pageText }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.body.innerText
    });

    // Ask AI to find matches
    const matches = await findMatches(apiKey, query, pageText);

    if (matches.length === 0) {
      status.textContent = 'No matches found';
      status.className = 'status';
      highlightBtn.disabled = false;
      return;
    }

    // Highlight matches on page
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: highlightOnPage,
      args: [matches]
    });

    status.textContent = `Highlighted ${matches.length} items`;
    status.className = 'status success';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
    status.className = 'status error';
  }

  highlightBtn.disabled = false;
});

clearBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      document.querySelectorAll('.ai-highlighter-mark').forEach(el => {
        el.outerHTML = el.innerHTML;
      });
    }
  });
  status.textContent = 'Cleared';
});

async function findMatches(apiKey, query, pageText) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You extract exact text snippets from a page. User wants to find: "${query}".
Return JSON object with "items" array containing exact text strings to highlight.
Only return text that exists verbatim in the page. Max 20 items.
Example: {"items": ["exact text 1", "exact text 2"]}`
        },
        {
          role: 'user',
          content: pageText.substring(0, 15000)
        }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  let content = data.choices[0].message.content;
  // Strip markdown code blocks if present
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'');

  const parsed = JSON.parse(content);
  // Handle both array and {items: []} formats
  const result = Array.isArray(parsed) ? parsed : (parsed.items || parsed.matches || []);
  console.log('AI returned matches:', result);
  return result;
}

function highlightOnPage(matches) {
  if (!matches || matches.length === 0) return;

  // Use browser's find-and-highlight via Range API
  const findAndHighlight = (searchText) => {
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

      // Try exact match first, then normalized match
      let idx = text.indexOf(searchText);
      if (idx === -1) {
        // Try case-insensitive
        idx = text.toLowerCase().indexOf(searchText.toLowerCase());
      }

      if (idx !== -1) {
        nodesToProcess.push({ node, idx, len: searchText.length });
        found = true;
      }
    }

    // Process in reverse to not mess up indices
    nodesToProcess.reverse().forEach(({ node, idx, len }) => {
      try {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + len);

        const mark = document.createElement('mark');
        mark.className = 'ai-highlighter-mark';
        range.surroundContents(mark);
      } catch (e) {
        // Range might span multiple nodes, use fallback
        console.log('Highlight fallback for:', searchText);
      }
    });

    return found;
  };

  let totalFound = 0;
  matches.forEach(match => {
    const found = findAndHighlight(match);
    if (found) totalFound++;
    console.log(`Searching for "${match}": ${found ? 'FOUND' : 'NOT FOUND'}`);
  });
  console.log(`Total highlighted: ${totalFound}/${matches.length}`);
}
