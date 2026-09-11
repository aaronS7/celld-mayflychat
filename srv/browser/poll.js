// One owner bounds each read through body consumption, then serializes delivery.
// Lifecycle events wake the owner; they never start another loop.
function createPoller({read, deliver, isStopped, onMissing, onUnauthorized, onStatus}) {
  let running = false, wake = null;
  async function start() {
    if (running || isStopped()) return;
    running = true;
    try {
      while (!isStopped()) {
        const controller = new AbortController();
        let restarted = false, failed = false;
        wake = () => { restarted = true; controller.abort(); };
        // The server's wait bounds only its hold, not a queued fetch or stalled body.
        const deadline = setTimeout(() => controller.abort(), 35000);
        try {
          const response = await read(controller.signal);
          if (response.status === 404) { onMissing(); return; }
          if (response.status === 401) { onUnauthorized(); return; }
          if (!response.ok) throw new Error(response.status);
          const page = await response.json();
          if (controller.signal.aborted) throw controller.signal.reason;
          clearTimeout(deadline);
          wake = null; // Delivery finishes before the next read or lifecycle nudge.
          if (isStopped()) return;
          await deliver(page.events);
          if (isStopped()) return;
          onStatus('');
        } catch (error) {
          if (isStopped()) return;
          failed = !restarted;
          if (failed) onStatus('Reconnecting…');
        } finally {
          clearTimeout(deadline);
          wake = null;
          controller.abort(); // Also release unread error-response bodies.
        }
        if (failed) await new Promise(resolve => {
          const done = () => { clearTimeout(retry); wake = null; resolve(); };
          const retry = setTimeout(done, 2000);
          wake = done;
        });
      }
    } finally { running = false; wake = null; }
  }
  return {start, wake() { wake?.(); }, get running() { return running; }};
}

function watchPollLifecycle(poller, onVisible) {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { onVisible(); poller.wake(); }
  });
  window.addEventListener('pageshow', event => { if (event.persisted) poller.wake(); });
  window.addEventListener('online', () => poller.wake());
}
