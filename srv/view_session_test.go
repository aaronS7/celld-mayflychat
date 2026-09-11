package srv

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestAnonymousBrowserWorkflow exercises the default name, the one rename
// chance before the first successful post, deletion, and the exact clipboard payload.
func TestAnonymousBrowserWorkflow(t *testing.T) {
	requireNode(t)
	// Copy must use the browser's own origin even where the relay trusts a
	// proxy's forwarded host for its curl instructions.
	_, ts := newTestServer(t, func(s *Server) { s.TrustProxy = true })
	k := b64u(NewK())
	ks, err := ParseK(k)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"id": ks.ID, "auth_hash": b64u(AuthHash(ks.Auth))})
	if r, body := do(t, "POST", ts.URL+"/new", string(body), nil); r.StatusCode != 303 {
		t.Fatalf("anonymous creation: %d %s", r.StatusCode, body)
	}
	_, html := do(t, "GET", ts.URL+"/c/"+ks.ID, "", htmlHdr(map[string]string{"X-Forwarded-Host": "wrong.example"}))
	script := inlineScript(t, html, "app")
	config, _ := json.Marshal(map[string]string{"host": ts.URL, "key": k, "id": ks.ID})
	prelude := readFile(t, "testdata/view_workflow_setup.cjs")
	checks := readFile(t, "testdata/view_workflow_checks.cjs")
	runNode(t, "const config="+string(config)+";\n"+prelude+script+checks)
}

// TestBrowserNameLockAndDelete covers the first-success boundary for title and
// reaction posts, in-flight name changes, failed first posts, and deletion
// through the served script against the real server.
func TestBrowserNameLockAndDelete(t *testing.T) {
	requireNode(t)
	_, ts := newTestServer(t)
	for _, first := range []string{"title", "reaction", "failed-then-message", "delete",
		"lost-message-poll", "lost-title-poll", "lost-reaction-poll",
		"lost-message-409", "lost-title-409", "lost-reaction-409",
		"lost-message-queue", "lost-message-inflight", "lost-title-500",
		"uncommitted-transport", "uncommitted-500", "uncommitted-400", "uncommitted-503", "uncommitted-restarting"} {
		t.Run(first, func(t *testing.T) {
			k := b64u(NewK())
			ks, err := ParseK(k)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := json.Marshal(map[string]string{"id": ks.ID, "auth_hash": b64u(AuthHash(ks.Auth))})
			if r, body := do(t, "POST", ts.URL+"/new", string(body), nil); r.StatusCode != 303 {
				t.Fatalf("anonymous creation: %d %s", r.StatusCode, body)
			}
			_, html := do(t, "GET", ts.URL+"/c/"+ks.ID, "", htmlHdr())
			if !strings.Contains(html, `<dialog id="deldialog">`) || !strings.Contains(html, `<button id="delbtn"`) || !strings.Contains(html, `fetch('/c/' + CID, {method:'DELETE'`) {
				t.Fatal("the view lacks its deletion control, confirmation dialog, or DELETE request")
			}
			if !strings.Contains(html, "Agents keep whatever they already saved") {
				t.Fatal("the delete confirmation must state the transcript limitation")
			}
			script := inlineScript(t, html, "app")
			config, _ := json.Marshal(map[string]string{"host": ts.URL, "key": k, "id": ks.ID, "first": first})
			prelude := readFile(t, "testdata/view_session_setup.cjs")
			checks := readFile(t, "testdata/view_session_checks.cjs")
			runNode(t, "const config="+string(config)+";\n"+prelude+script+checks)
		})
	}
}
