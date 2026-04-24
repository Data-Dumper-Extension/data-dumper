// Forward selector confirmations from content → popup
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "SELECTORS_CONFIRMED") {
    // Store temporarily so popup can retrieve
    browser.storage.local.set({ lastSelectors: msg.selectors });
  }
});
