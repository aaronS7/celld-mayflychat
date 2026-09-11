package srv

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"
)

func TestBrowserDeleteReload(t *testing.T) {
	chrome := os.Getenv("CHROME_BIN")
	if chrome == "" {
		t.Skip("set CHROME_BIN to a Chrome/Chromium executable for real DOM/network tests")
	}
	for _, mode := range []string{"confirmed-204", "confirmed-404", "remote-poll-404", "cancel", "http-failure", "transport-failure"} {
		t.Run(mode, func(t *testing.T) {
			s, ts := newTestServer(t)
			id, key := createChannel(t, ts)
			ks, err := ParseK(key)
			if err != nil {
				t.Fatal(err)
			}
			channel := chn{ts: ts, id: id, k: key, ks: ks, name: "Fixture"}
			path := "/c/" + id
			config, err := json.Marshal(map[string]string{
				"mode": mode, "path": path + "#" + key,
				"title": "Retired title fixture", "text": "Retired transcript fixture",
			})
			if err != nil {
				t.Fatal(err)
			}
			var documents, reads, held, deletes, posts, creates, images, deleteStatus atomic.Int32
			result := make(chan string, 1)
			app := s.Handler()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/test-frame":
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					fmt.Fprintf(w, "<!doctype html><meta charset=utf-8><link rel=icon href=data:,><body><script>const config=%s;\n%s</script>", config, deleteBrowserChecks)
					return
				case "/test-result":
					b, _ := io.ReadAll(r.Body)
					select {
					case result <- string(b):
					case <-r.Context().Done():
					}
					w.WriteHeader(http.StatusNoContent)
					return
				case "/test-state":
					json.NewEncoder(w).Encode(map[string]int32{
						"documents": documents.Load(), "reads": reads.Load(), "held": held.Load(),
						"deletes": deletes.Load(), "posts": posts.Load(), "creates": creates.Load(),
						"images": images.Load(), "deleteStatus": deleteStatus.Load(),
					})
					return
				case "/test-remove":
					// Act as a second participant through the real authenticated DELETE handler.
					r = r.Clone(r.Context())
					r.Method = http.MethodDelete
					r.URL.Path = path
					r.Header.Set("Authorization", "Bearer "+ks.Auth)
					app.ServeHTTP(w, r)
					return
				case "/test-image.png":
					images.Add(1)
					w.Header().Set("Content-Type", "image/png")
					png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6u0AAAAASUVORK5CYII=")
					w.Write(png)
					return
				case "/new":
					if r.Method == http.MethodPost {
						creates.Add(1)
					}
				case path:
					if r.Method == http.MethodGet {
						documents.Add(1)
					}
					if r.Method == http.MethodDelete {
						deletes.Add(1)
						switch mode {
						case "http-failure":
							deleteStatus.Store(http.StatusServiceUnavailable)
							w.Header().Set("Content-Type", "application/json")
							w.WriteHeader(http.StatusServiceUnavailable)
							io.WriteString(w, `{"error":"fixture unavailable"}`)
							return
						case "transport-failure":
							// Drop an actual Chrome fetch, without deleting or mocking fetch/reload.
							conn, _, err := http.NewResponseController(w).Hijack()
							if err != nil {
								t.Error(err)
								w.WriteHeader(http.StatusInternalServerError)
								return
							}
							conn.Close()
							return
						}
						response := httptest.NewRecorder()
						app.ServeHTTP(response, r)
						deleteStatus.Store(int32(response.Code))
						for name, values := range response.Header() {
							w.Header()[name] = values
						}
						w.WriteHeader(response.Code)
						io.Copy(w, response.Body)
						return
					}
				case path + "/events":
					if r.Method == http.MethodPost {
						posts.Add(1)
					}
					if r.Method == http.MethodGet {
						reads.Add(1)
						if r.URL.Query().Get("since") == "1" {
							held.Add(1)
							if mode != "remote-poll-404" {
								// Isolate DELETE's transition from a competing poll 404. The
								// remote case below leaves the real long-poll handler untouched.
								<-r.Context().Done()
								return
							}
						}
					}
				}
				// Keep documents/scripts intact but permit this observing iframe.
				// TestBrowserCSP separately verifies the enforced framing prohibition.
				if r.Method == http.MethodGet && r.URL.Path == path {
					app.ServeHTTP(withoutCSPForDOMTests{w}, r)
					return
				}
				app.ServeHTTP(w, r)
			}))
			defer server.Close()
			for i, text := range []string{"/title Retired title fixture", "Retired transcript fixture\n\n![Loaded fixture](" + server.URL + "/test-image.png)"} {
				if code, _ := channel.post(t, i-1, text); code != http.StatusOK {
					t.Fatalf("seed: %d", code)
				}
			}

			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, chrome, "--headless", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--user-data-dir="+t.TempDir(), "--window-size=1280,900", server.URL+"/test-frame")
			var output bytes.Buffer
			cmd.Stdout, cmd.Stderr = &output, &output
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { cancel(); cmd.Wait() }()
			select {
			case raw := <-result:
				var got struct {
					OK bool `json:"ok"`
				}
				if err := json.Unmarshal([]byte(raw), &got); err != nil || !got.OK {
					t.Fatalf("browser: %s (%v)", raw, err)
				}
				t.Log(raw)
			case <-ctx.Done():
				t.Fatal("channel deletion browser test timed out")
			}
			if posts.Load() != 0 || creates.Load() != 0 {
				t.Fatalf("unwanted browser writes: posts=%d creates=%d", posts.Load(), creates.Load())
			}
			want := http.StatusNotFound
			if mode == "cancel" || mode == "http-failure" || mode == "transport-failure" {
				want = http.StatusOK
				if got := channel.read(t, -1); got.Last != 1 || len(got.Messages) != 2 {
					t.Fatalf("failed/canceled deletion changed history: %+v", got)
				}
			}
			if resp, _ := do(t, http.MethodGet, ts.URL+path, "", htmlHdr()); resp.StatusCode != want {
				t.Fatalf("channel after %s: %d, want %d", mode, resp.StatusCode, want)
			}
		})
	}
}

// The parent survives an actual iframe navigation; neither the page's script nor
// Location.reload is replaced. Only the local cases delay the competing poll.
const deleteBrowserChecks = `
const frame = document.createElement('iframe');
frame.style = 'width:1200px;height:850px;border:0';
let loads = 0;
frame.addEventListener('load', () => loads++);
frame.src = config.path;
document.body.append(frame);
const assert = (ok, message) => { if (!ok) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, message) => {
  const end = performance.now() + 5000;
  while (!await fn()) {
    if (performance.now() > end) throw Error('timed out: ' + message);
    await sleep(10);
  }
};
const state = async () => (await fetch('/test-state')).json();
const report = result => fetch('/test-result', {method:'POST', body:JSON.stringify(result)});
(async () => {
  await until(() => loads === 1 && frame.contentDocument.querySelector('#m1 .load-image'), 'real initial poll renders fixture');
  const w = frame.contentWindow, d = frame.contentDocument, originalURL = w.location.href;
  const title = d.getElementById('title'), log = d.getElementById('log');
  const draft = d.getElementById('text'), compose = d.getElementById('compose');
  const dialog = d.getElementById('deldialog'), button = d.getElementById('delbtn');
  assert(title.textContent === config.title && d.title.includes(config.title), 'seed title is rendered');
  assert(log.textContent.includes(config.text), 'seed transcript is rendered');
  assert((await state()).images === 0, 'image has not loaded without consent');
  d.querySelector('.load-image').click();
  await until(() => d.querySelector('#m1 img')?.naturalWidth > 0, 'consented image loads');
  const image = d.querySelector('#m1 img');
  draft.value = 'Unsent message fixture';
  draft.dispatchEvent(new w.Event('input', {bubbles:true}));
  await until(async () => (await state()).held > 0, 'next poll is outstanding');
  assert((await state()).posts === 0, 'setup did not post');

  if (config.mode === 'remote-poll-404') {
    // Deletion must not submit a dirty title when channelGone moves focus.
    d.querySelector('.addreact').click();
    assert(!d.getElementById('picker').hidden, 'picker is open before remote deletion');
    d.getElementById('editbtn').click();
    title.textContent = 'Unsent title fixture';
    assert(d.activeElement === title, 'dirty title is focused');
    assert((await fetch('/test-remove', {method:'POST'})).status === 204, 'remote participant deletes');
  } else {
    button.click();
    assert(dialog.open, 'Delete opens real confirmation dialog');
    assert((await state()).deletes === 0, 'opening confirmation does not delete');
    if (config.mode === 'confirmed-404') {
      assert((await fetch('/test-remove', {method:'POST'})).status === 204, 'channel disappears before confirmation');
    }
    dialog.querySelector('[value="' + (config.mode === 'cancel' ? 'cancel' : 'delete') + '"]').click();
    await until(() => !dialog.open, 'confirmation closes');
  }

  const preserved = ['cancel', 'http-failure', 'transport-failure'].includes(config.mode);
  if (preserved) {
    if (config.mode !== 'cancel') {
      await until(() => !d.getElementById('delete-status').hidden, 'deletion failure feedback');
      const feedback = d.getElementById('delete-status').textContent;
      assert(feedback.startsWith('Could not delete:'), 'failure remains visible');
      if (config.mode === 'http-failure') assert(feedback.includes('fixture unavailable'), 'HTTP error detail');
      else assert(feedback.includes('Failed to fetch'), 'actual transport failure');
    }
    const settled = await state();
    await sleep(300);
    assert(frame.contentDocument === d && loads === 1, 'cancel/failure must not replace document');
    assert(w.location.href === originalURL, 'cancel/failure keeps URL and fragment');
    assert(title.textContent === config.title && d.title.includes(config.title), 'title preserved');
    assert(d.getElementById('log') === log && log.textContent.includes(config.text), 'transcript preserved');
    assert(d.querySelector('#m1 img') === image && image.complete && image.naturalWidth > 0, 'loaded image preserved');
    assert(draft.value === 'Unsent message fixture' && !compose.hidden && !draft.disabled, 'editable draft preserved');
    assert(!button.disabled, 'failed deletion leaves retry available');
    const after = await state();
    assert(after.documents === 1 && after.images === 1, 'no reload or image refetch');
    // Chrome can replay an idempotent DELETE after a reused socket closes before headers.
    if (config.mode === 'transport-failure') assert(after.deletes >= 1 && after.deletes === settled.deletes, 'transport failure settles without application retries');
    else assert(after.deletes === (config.mode === 'cancel' ? 0 : 1), 'one HTTP attempt, none on cancel');
    if (config.mode === 'cancel') assert(d.getElementById('delete-status').hidden, 'cancel does not report failure');
  } else {
    await until(() => frame.contentDocument !== d && frame.contentDocument.querySelector('h1')?.textContent === 'No such channel', 'reload reaches existing missing-channel page');
    const next = frame.contentDocument;
    await until(() => next.readyState === 'complete' && loads === 2, 'reloaded document completes');
    assert(w.location.href === originalURL && w.location.pathname + w.location.hash === config.path, 'reload retains exact channel URL and key fragment');
    assert(w.performance.getEntriesByType('navigation')[0].type === 'reload', 'Chrome performed a real reload');
    assert(next.title === 'No such channel — Mayfly Chat', 'old tab title replaced');
    const create = next.querySelector('header #newbtn');
    assert(create?.tagName === 'A' && create.getAttribute('href') === '/#new' && create.textContent === 'New channel', 'deleted page retains native channel creation');
    assert(create.tabIndex === 0 && create.getBoundingClientRect().width > 0 && !create.hasAttribute('aria-disabled'), 'New channel stays visible and keyboard accessible');
    assert(!next.querySelector('#log, #title, #compose, #text, #picker, img, [contenteditable]'), 'old transcript, image, editors and picker leave the document');
    for (const text of [config.title, config.text, 'Unsent message fixture', 'Unsent title fixture']) {
      assert(!next.documentElement.outerHTML.includes(text), 'no retained content: ' + text);
    }
    const before = await state();
    w.dispatchEvent(new w.Event('online'));
    w.dispatchEvent(new w.PageTransitionEvent('pageshow', {persisted:true}));
    next.dispatchEvent(new w.Event('visibilitychange'));
    await sleep(300);
    const after = await state();
    assert(frame.contentDocument === next && loads === 2 && after.documents === 2, 'one reload, not a navigation loop');
    assert(after.reads === before.reads && after.images === 1, 'missing page neither polls nor reloads old image');
    if (config.mode === 'remote-poll-404') assert(after.deletes === 0, 'real poll alone noticed remote absence');
    else assert(after.deletes === 1 && after.deleteStatus === (config.mode === 'confirmed-204' ? 204 : 404), 'actual DELETE response confirms absence');
  }
  const after = await state();
  assert(after.posts === 0 && after.creates === 0, 'no unwanted posts, title saves or creations');
  await report({ok:true, mode:config.mode, loads, requests:after});
})().catch(error => report({ok:false, mode:config.mode, error:String(error), stack:error.stack}));
`
