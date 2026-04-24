// Forward selector confirmations from content → popup
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "SELECTORS_CONFIRMED") {
    // Store temporarily so popup can retrieve
    chrome.storage.local.set({ lastSelectors: msg.selectors });
  }
});
