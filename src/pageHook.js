(() => {
  const isTimedTextUrl = (value) => {
    if (typeof value !== "string") return false;
    const url = value.toLowerCase();
    return (
      url.includes("timedtext") ||
      url.includes("webvtt") ||
      url.includes("dfxp") ||
      url.includes("ttml") ||
      url.includes("nflxvideo.net") && (url.includes("vtt") || url.includes("tt") || url.includes("subtitle"))
    );
  };

  const postUrl = (url) => {
    if (!isTimedTextUrl(url)) return;
    window.postMessage(
      {
        source: "ncs-page-hook",
        type: "TIMED_TEXT_URL",
        url
      },
      window.location.origin
    );
  };

  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      postUrl(url);
    } catch (_) {
      // Keep Netflix playback untouched if the hook cannot inspect a request.
    }
    return originalFetch.apply(this, arguments);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    try {
      postUrl(url);
    } catch (_) {
      // Keep the native XHR behavior intact.
    }
    return originalOpen.apply(this, arguments);
  };

  const scanPerformanceEntries = () => {
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        postUrl(entry.name);
      }
    } catch (_) {
      // Performance entries are a best-effort fallback.
    }
  };

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        postUrl(entry.name);
      }
    });
    observer.observe({ type: "resource", buffered: true });
  } catch (_) {
    window.setInterval(scanPerformanceEntries, 2500);
  }

  scanPerformanceEntries();
})();
