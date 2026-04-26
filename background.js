const NTP_URLS = new Set([
  "chrome://newtab/",
  "chrome://newtab",
  "chrome://new-tab-page/",
  "chrome://new-tab-page",
  "chrome://new-tab-page-third-party/",
  "chrome://new-tab-page-third-party",
  "chrome://start-page",
]);
const NTP_URL_PREFIXES = ["chrome://start-page/"];
const REMOVE_RETRY_DELAYS_MS = [75, 150, 300, 600, 1000, 1500, 2500];
const POLL_ALARM = "ntp-poll";

const removing = new Set();
let reconcileTimer = null;

function isNtp(tab) {
  const url = tab?.pendingUrl || tab?.url || "";
  return (
    NTP_URLS.has(url) ||
    NTP_URL_PREFIXES.some((prefix) => url.startsWith(prefix))
  );
}

// Core rule: close any NTP that isn't the active tab in its window.
// `tab.active` is per-window, so each window independently keeps at most
// one active NTP — which is the correct behavior.
function reconcile() {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs) {
      if (tab.id != null && !tab.active && isNtp(tab)) {
        closeTab(tab.id);
      }
    }
  });
}

function scheduleReconcile(delay = 50) {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(reconcile, delay);
}

function closeTab(tabId, attempt = 0) {
  if (attempt === 0 && removing.has(tabId)) return;
  removing.add(tabId);

  chrome.tabs.remove(tabId, () => {
    const err = chrome.runtime.lastError;
    if (!err || err.message?.startsWith("No tab with id:")) {
      removing.delete(tabId);
      scheduleReconcile();
      return;
    }

    const delay = REMOVE_RETRY_DELAYS_MS[attempt];
    if (delay == null) {
      removing.delete(tabId);
      return;
    }
    setTimeout(() => closeTab(tabId, attempt + 1), delay);
  });
}

// --- Events ---
// Every event that could change which NTPs are active triggers a reconcile.
// The debounce collapses rapid-fire events into one pass.

chrome.tabs.onActivated.addListener(() => scheduleReconcile());

chrome.tabs.onCreated.addListener(() => scheduleReconcile(150));

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    scheduleReconcile();
  }
});

chrome.tabs.onReplaced.addListener(() => scheduleReconcile());

chrome.tabs.onAttached.addListener(() => scheduleReconcile());
chrome.tabs.onDetached.addListener(() => scheduleReconcile());

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    scheduleReconcile();
  }
});

chrome.windows.onCreated.addListener(() => scheduleReconcile());

// webNavigation fires for chrome:// navigations that tabs.onUpdated may skip
// in some Chromium forks.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) scheduleReconcile();
});

// Deprecated APIs some Chromium forks still support
if (chrome.tabs.onSelectionChanged) {
  chrome.tabs.onSelectionChanged.addListener(() => scheduleReconcile());
}
if (chrome.tabs.onActiveChanged) {
  chrome.tabs.onActiveChanged.addListener(() => scheduleReconcile());
}

// --- Polling ---
// Service workers die after ~30s of inactivity. Alarms survive that and
// wake the worker, catching any NTPs the event system missed.
chrome.alarms.create(POLL_ALARM, {
  delayInMinutes: 0.1,
  periodInMinutes: 0.5,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) reconcile();
});

// --- Startup ---
chrome.runtime.onInstalled.addListener(() => scheduleReconcile(200));
chrome.runtime.onStartup.addListener(() => scheduleReconcile(200));
scheduleReconcile(100);
