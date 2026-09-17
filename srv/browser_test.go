package srv

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"
)

func requireNode(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for browser JS tests")
	}
}

// runNode runs a CommonJS fixture and reports its output on failure.
func runNode(t *testing.T, source string) string {
	t.Helper()
	return runNodeWithin(t, source, 60*time.Second)
}

func runNodeWithin(t *testing.T, source string, timeout time.Duration) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "page.cjs")
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "node", path).CombinedOutput()
	if err != nil {
		t.Fatalf("browser script: %v\n%s", err, out)
	}
	return string(out)
}

// inlineScript reads a trusted script from served HTML, regardless of its nonce.
func inlineScript(t *testing.T, page, id string) string {
	t.Helper()
	for _, script := range regexp.MustCompile(`(?s)<script\b([^>]*)>(.*?)</script>`).FindAllStringSubmatch(page, -1) {
		if id == "" || strings.Contains(script[1], `id="`+id+`"`) {
			return script[2]
		}
	}
	t.Fatalf("script %q missing", id)
	return ""
}

func withoutNonces(page string) string {
	return regexp.MustCompile(` nonce="[A-Za-z0-9+/_=-]+"`).ReplaceAllString(page, "")
}

// replaceStartup replaces the page bootstrap while preserving its application code.
func replaceStartup(t *testing.T, page, script string) string {
	t.Helper()
	pattern := regexp.MustCompile(`(?s)<script id="startup"[^>]*>.*?</script>`)
	if len(pattern.FindAllStringIndex(page, -1)) != 1 {
		t.Fatal("expected one page bootstrap")
	}
	return pattern.ReplaceAllStringFunc(page, func(string) string { return "<script>" + script + "</script>" })
}

type browserPage struct {
	Chrome  string `json:"chrome"`
	URL     string `json:"url"`
	Profile string `json:"profile"`
	Dark    bool   `json:"dark"`
}

// startBrowser loads a fixture with an explicit color scheme, independent of the host theme.
func startBrowser(t *testing.T, ctx context.Context, page browserPage) {
	t.Helper()
	requireNode(t)
	page.Profile = t.TempDir()
	config, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	source := "const config=" + string(config) + ";\n" + readFile(t, "testdata/chrome.cjs") + `
(async () => {
 const {targetId} = await cdp('Target.createTarget', {url:'about:blank'});
 const tab = await attach(targetId);
 await cdp('Emulation.setEmulatedMedia', {features:[{name:'prefers-color-scheme', value:config.dark?'dark':'light'}]}, tab.sessionId);
 await cdp('Page.bringToFront', {}, tab.sessionId);
 await cdp('Page.navigate', {url:config.url}, tab.sessionId);
})().catch(error => {console.error(error);chrome.kill();process.exitCode=1});
process.on('SIGTERM', () => chrome.kill());
`
	path := filepath.Join(t.TempDir(), "browser.cjs")
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, "node", path)
	// Let the harness reap Chrome before forcing the Node process down.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 2 * time.Second
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Cancel()
		_ = cmd.Wait()
		if t.Failed() {
			t.Log(output.String())
		}
	})
}
