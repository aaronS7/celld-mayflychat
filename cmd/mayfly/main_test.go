package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/josharian/mayfly/srv"
)

func TestFlagDefaults(t *testing.T) {
	if got := flag.Lookup("listen").DefValue; got != "127.0.0.1:8000" {
		t.Errorf("default listen address = %q", got)
	}
	if got := flag.Lookup("trust-proxy").DefValue; got != "false" {
		t.Errorf("default proxy trust = %q", got)
	}
	if *flagTrustProxy {
		t.Error("proxy trust must require explicit opt-in")
	}
	if got := flag.Lookup("db").DefValue; got != "mayfly.sqlite3" {
		t.Errorf("default database = %q", got)
	}
	if got := flag.Lookup("retention").DefValue; got != (24 * time.Hour).String() {
		t.Errorf("default retention = %q", got)
	}
	if srv.DefaultRetention != 24*time.Hour {
		t.Errorf("srv.DefaultRetention = %v", srv.DefaultRetention)
	}
}

func TestRetentionFlag(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want time.Duration
	}{
		{"default", nil, 24 * time.Hour},
		{"disabled", []string{"-retention=0"}, 0},
		{"custom", []string{"-retention=90m"}, 90 * time.Minute},
		{"fractional", []string{"-retention=1.5s"}, 1500 * time.Millisecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := flag.Lookup("retention")
			old := f.Value.String()
			t.Cleanup(func() {
				if err := f.Value.Set(old); err != nil {
					t.Fatal(err)
				}
			})
			if err := f.Value.Set(f.DefValue); err != nil {
				t.Fatal(err)
			}
			fs := flag.NewFlagSet("mayfly", flag.ContinueOnError)
			fs.SetOutput(io.Discard)
			fs.Var(f.Value, f.Name, f.Usage)
			if err := fs.Parse(tc.args); err != nil {
				t.Fatal(err)
			}
			if *flagRetention != tc.want {
				t.Fatalf("retention = %v, want %v", *flagRetention, tc.want)
			}
			s, err := srv.New(filepath.Join(t.TempDir(), "t.sqlite3"), *flagRetention)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if s.TrustProxy {
				t.Error("new servers must not trust forwarded headers by default")
			}
			if s.Retention != tc.want {
				t.Errorf("server retention = %v, want %v", s.Retention, tc.want)
			}
		})
	}
}

func TestCommandRejectsBadFlagsWithoutDatabase(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{"negative default path", []string{"-retention=-1ns"}, "retention"},
		{"negative custom path", []string{"-retention=-1h", "-db=custom.sqlite3"}, "retention"},
		{"malformed duration", []string{"-retention=forever"}, "invalid value"},
		{"malformed proxy boolean", []string{"-trust-proxy=automatic"}, "invalid boolean value"},
		{"unknown flag", []string{"-unknown-option=true"}, "flag provided but not defined"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			output, err := command(t, dir, tc.args...)
			if err == nil || !strings.Contains(output, tc.want) {
				t.Fatalf("command = %v, output = %q; want %q", err, output, tc.want)
			}
			files, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			if len(files) != 0 {
				t.Fatalf("invalid startup created files: %v", files)
			}
		})
	}
}

func TestCommandIncompatibleDefaultDatabase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mayfly.sqlite3")
	d, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.Exec(`CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('untouched plaintext')`); err != nil {
		t.Fatal(err)
	}
	var beforeSchema string
	if err := d.QueryRow(`SELECT sql FROM sqlite_schema WHERE name='messages'`).Scan(&beforeSchema); err != nil {
		t.Fatal(err)
	}
	output, err := command(t, dir)
	if err == nil {
		t.Fatalf("started with incompatible default database: %q", output)
	}
	for _, want := range []string{"incompatible database schema", "fresh database", "-db", "mayfly-new.sqlite3"} {
		if !strings.Contains(output, want) {
			t.Errorf("error %q lacks %q", output, want)
		}
	}
	var text, afterSchema string
	if err := d.QueryRow(`SELECT text FROM messages`).Scan(&text); err != nil {
		t.Fatal(err)
	}
	if err := d.QueryRow(`SELECT sql FROM sqlite_schema WHERE name='messages'`).Scan(&afterSchema); err != nil {
		t.Fatal(err)
	}
	if text != "untouched plaintext" || afterSchema != beforeSchema {
		t.Fatalf("incompatible database changed: %q, %q", text, afterSchema)
	}
	var tables int
	if err := d.QueryRow(`SELECT COUNT(*) FROM sqlite_schema WHERE type='table'`).Scan(&tables); err != nil {
		t.Fatal(err)
	}
	if tables != 1 {
		t.Fatalf("incompatible startup created tables: %d", tables)
	}
}

func TestCommandHelp(t *testing.T) {
	output, err := command(t, t.TempDir(), "-h")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"-listen string", `default "127.0.0.1:8000"`, "plain HTTP; terminate TLS externally", "-trust-proxy", "X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host", "isolated backend behind a trusted proxy", "-retention duration", "default 24h0m0s", "0 disables automatic expiry", "incompatible databases require a fresh path"} {
		if !strings.Contains(output, want) {
			t.Errorf("help lacks %q: %s", want, output)
		}
	}
}

func TestCommandTrustProxy(t *testing.T) {
	for _, tc := range []struct {
		name  string
		args  []string
		trust bool
	}{
		{"default", nil, false},
		{"enabled", []string{"-trust-proxy"}, true},
		{"explicit true", []string{"-trust-proxy=true"}, true},
		{"explicit false", []string{"-trust-proxy=false"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			origin := startCommand(t, tc.args...)
			client := &http.Client{
				Timeout:       3 * time.Second,
				CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			}
			t.Cleanup(client.CloseIdleConnections)
			const id = "AAAAAAAAAAAAAAAAAAAAAA"
			auth := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
			hash := sha256.Sum256([]byte(auth))
			request := func(method, path, body string, status int) string {
				t.Helper()
				r, err := http.NewRequest(method, origin+path, strings.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				r.Header.Set("Authorization", "Bearer "+auth)
				r.Header.Set("Content-Type", "application/json")
				r.Header["X-Forwarded-For"] = []string{"192.0.2.1", "198.51.100.2, 2001:db8::3"}
				r.Header.Set("X-Forwarded-Proto", "https")
				r.Header.Set("X-Forwarded-Host", "public.example.test")
				resp, err := client.Do(r)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				raw, err := io.ReadAll(resp.Body)
				if err != nil {
					t.Fatal(err)
				}
				if resp.StatusCode != status {
					t.Fatalf("%s %s: %d want %d: %s", method, path, resp.StatusCode, status, raw)
				}
				return string(raw)
			}
			request("POST", "/new", fmt.Sprintf(`{"id":%q,"auth_hash":%q}`, id, base64.RawURLEncoding.EncodeToString(hash[:])), http.StatusSeeOther)
			guide := request("GET", "/c/"+id, "", http.StatusOK)
			wantOrigin, wantSource := origin, "127.0.0.1"
			if tc.trust {
				wantOrigin, wantSource = "https://public.example.test", "2001:db8::3"
			}
			if !strings.Contains(guide, wantOrigin+"/static/client.py") || !strings.Contains(guide, wantOrigin+"/llms.txt") {
				t.Fatalf("instructions do not use %s: %s", wantOrigin, guide)
			}
			if !tc.trust && strings.Contains(guide, "public.example.test") {
				t.Fatal("default command accepted a forged origin")
			}
			// The relay accepts opaque envelopes; this fixture needs no participant crypto.
			envelope := fmt.Sprintf(`{"nonce":%q,"ct":%q,"src":"forged-source"}`,
				base64.RawURLEncoding.EncodeToString(make([]byte, 12)),
				base64.RawURLEncoding.EncodeToString(make([]byte, 16)))
			request("POST", "/c/"+id+"/events?last=-1", envelope, http.StatusOK)
			raw := request("GET", "/c/"+id+"/events", "", http.StatusOK)
			var reply struct {
				Events []struct {
					Src string `json:"src"`
				} `json:"events"`
			}
			if err := json.Unmarshal([]byte(raw), &reply); err != nil {
				t.Fatal(err)
			}
			if len(reply.Events) != 1 || reply.Events[0].Src != wantSource {
				t.Fatalf("event source: %s, want %s", raw, wantSource)
			}
		})
	}
}

func TestCommandSIGTERMDrainsWaitsAndRestarts(t *testing.T) {
	dir := t.TempDir()
	p := startCommandProcess(t, dir)
	var posts, reads []*pendingCommandReply
	var paths []string
	for i := range 4 {
		path := createCommandChannel(t, p, byte(i))
		paths = append(paths, path)
		posts = append(posts, sendCommandRequest(t, p, "POST", path+"?last=-1&wait=86400", commandEnvelope(byte(i))))
		// Observe the committed write through a separate TCP request, not a flush
		// or a sleep. Its original POST response must still be waiting.
		waitCommandHead(t, p, path, 0)
		for range 8 {
			reads = append(reads, sendCommandRequest(t, p, "GET", path+"?since=0&wait=86400", ""))
		}
	}
	// Every request is fully written before this settling interval. No event
	// can wake these reads; the only expected response is shutdown's refusal.
	time.Sleep(50 * time.Millisecond)
	for _, pending := range append(append([]*pendingCommandReply{}, posts...), reads...) {
		select {
		case reply := <-pending.done:
			t.Fatalf("held request completed before SIGTERM: status=%d body=%s err=%v", reply.status, reply.body, reply.err)
		default:
		}
	}
	if elapsed := p.stop(t, syscall.SIGTERM); elapsed > time.Second {
		t.Errorf("normal drain took %v; want <=1s including scheduling tolerance", elapsed)
	}
	// Read complete HTTP bodies separately from measuring process exit.
	for _, pending := range reads {
		reply := pending.receive(t, http.StatusServiceUnavailable).events(t)
		if reply.Error != "restarting" || reply.Posted != nil || reply.Hint == "" ||
			(!strings.Contains(strings.ToLower(reply.Hint), "retry") && !strings.Contains(strings.ToLower(reply.Hint), "try again")) {
			t.Fatalf("held GET restart reply: %+v", reply)
		}
	}
	for _, pending := range posts {
		reply := pending.receive(t, http.StatusOK).events(t)
		if reply.Posted == nil || !*reply.Posted || reply.ID == nil || *reply.ID != 0 ||
			reply.Last == nil || *reply.Last != 0 || reply.More == nil || *reply.More || reply.Events == nil || len(reply.Events) != 0 || reply.Error != "" {
			t.Fatalf("committed POST wait lost its normal acknowledgement: %+v", reply)
		}
	}
	t.Logf("received complete restart replies for %d GET waits and normal acknowledgements for %d committed POST waits", len(reads), len(posts))

	// Only now start the replacement, with the exact same default database.
	replacement := startCommandProcess(t, dir)
	for i, path := range paths {
		assertCommandHistory(t, replacement, path, byte(i))
		conflict := sendCommandRequest(t, replacement, "POST", path+"?last=-1", commandEnvelope(99)).receive(t, http.StatusConflict).events(t)
		if conflict.Error != "conflict" || conflict.Posted == nil || *conflict.Posted || conflict.Last == nil || *conflict.Last != 0 {
			t.Fatalf("stale CAS after replacement: %+v", conflict)
		}
		ack := sendCommandRequest(t, replacement, "POST", path+"?last=0", commandEnvelope(byte(i+10))).receive(t, http.StatusOK).events(t)
		if ack.Posted == nil || !*ack.Posted || ack.ID == nil || *ack.ID != 1 {
			t.Fatalf("next CAS did not use dense sequence 1: %+v", ack)
		}
		assertCommandHistory(t, replacement, path, byte(i), byte(i+10))
	}
}

func TestCommandSIGTERMBoundsIncompleteAndDisconnectedRequests(t *testing.T) {
	dir := t.TempDir()
	p := startCommandProcess(t, dir)
	path := createCommandChannel(t, p, 0)
	pending := sendCommandRequest(t, p, "POST", path+"?last=-1&wait=86400", commandEnvelope(1))
	waitCommandHead(t, p, path, 0)
	// The accepted write must survive even though its caller abandons the reply.
	if err := pending.conn.Close(); err != nil {
		t.Fatal(err)
	}

	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(p.origin, "http://"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	// 100 Continue proves this POST reached the handler's body read. Leave the
	// body incomplete so the drain ceiling, rather than a held-wait wakeup,
	// must bound exit. This request has not supplied a writable envelope.
	_, err = fmt.Fprintf(conn, "POST %s?last=0 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n", path, commandBearer())
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: "POST"})
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusContinue {
		t.Fatalf("incomplete POST was not admitted: %s", response.Status)
	}
	if _, err := io.WriteString(conn, "{"); err != nil {
		t.Fatal(err)
	}
	if elapsed := p.stop(t, syscall.SIGTERM); elapsed > time.Second {
		t.Errorf("incomplete request delayed process exit by %v; want <=1s including scheduling tolerance", elapsed)
	}
	replacement := startCommandProcess(t, dir)
	assertCommandHistory(t, replacement, path, 1)
	ack := sendCommandRequest(t, replacement, "POST", path+"?last=0", commandEnvelope(2)).receive(t, http.StatusOK).events(t)
	if ack.Posted == nil || !*ack.Posted || ack.ID == nil || *ack.ID != 1 {
		t.Fatalf("incomplete POST consumed the next sequence: %+v", ack)
	}
	assertCommandHistory(t, replacement, path, 1, 2)
}

func TestCommandKilledAfterCommitRecovers(t *testing.T) {
	dir := t.TempDir()
	p := startCommandProcess(t, dir)
	path := createCommandChannel(t, p, 0)
	pending := sendCommandRequest(t, p, "POST", path+"?last=-1&wait=86400", commandEnvelope(3))
	waitCommandHead(t, p, path, 0)
	// No graceful shutdown, checkpoint, sidecar removal, or client retry:
	// replacement must recover the commit whose response was interrupted.
	p.stop(t, syscall.SIGKILL)
	select {
	case reply := <-pending.done:
		if reply.err == nil {
			t.Fatalf("killed held POST unexpectedly returned a complete response: %d %s", reply.status, reply.body)
		}
	case <-time.After(time.Second):
		t.Fatal("killed process did not close the held POST connection")
	}
	replacement := startCommandProcess(t, dir)
	assertCommandHistory(t, replacement, path, 3)
	ack := sendCommandRequest(t, replacement, "POST", path+"?last=0", commandEnvelope(4)).receive(t, http.StatusOK).events(t)
	if ack.Posted == nil || !*ack.Posted || ack.ID == nil || *ack.ID != 1 {
		t.Fatalf("CAS after crash recovery: %+v", ack)
	}
	assertCommandHistory(t, replacement, path, 3, 4)
}

type commandEventReply struct {
	Error  string      `json:"error"`
	Hint   string      `json:"hint"`
	Posted *bool       `json:"posted"`
	ID     *int64      `json:"id"`
	Last   *int64      `json:"last"`
	More   *bool       `json:"more"`
	Events []srv.Event `json:"events"`
}

type commandReply struct {
	status      int
	contentType string
	body        []byte
	err         error
}

type pendingCommandReply struct {
	conn net.Conn
	done chan commandReply
}

func commandBearer() string {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 32))
}

func commandEnvelope(marker byte) string {
	return fmt.Sprintf(`{"nonce":%q,"ct":%q}`,
		base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{marker}, 12)),
		base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{marker}, 16)))
}

func createCommandChannel(t *testing.T, p *commandProcess, marker byte) string {
	t.Helper()
	id := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{marker}, 16))
	hash := sha256.Sum256([]byte(commandBearer()))
	body := fmt.Sprintf(`{"id":%q,"auth_hash":%q}`, id, base64.RawURLEncoding.EncodeToString(hash[:]))
	sendCommandRequest(t, p, "POST", "/new", body).receive(t, http.StatusSeeOther)
	return "/c/" + id + "/events"
}

// sendCommandRequest writes a whole request to a real socket before returning.
func sendCommandRequest(t *testing.T, p *commandProcess, method, path, body string) *pendingCommandReply {
	t.Helper()
	r, err := http.NewRequest(method, p.origin+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+commandBearer())
	r.Header.Set("Content-Type", "application/json")
	conn, err := net.DialTimeout("tcp", r.URL.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := r.Write(conn); err != nil {
		t.Fatal(err)
	}
	pending := &pendingCommandReply{conn: conn, done: make(chan commandReply, 1)}
	go func() {
		defer conn.Close()
		response, err := http.ReadResponse(bufio.NewReader(conn), r)
		if err != nil {
			pending.done <- commandReply{err: err}
			return
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		pending.done <- commandReply{status: response.StatusCode, contentType: response.Header.Get("Content-Type"), body: raw, err: err}
	}()
	return pending
}

func (pending *pendingCommandReply) receive(t *testing.T, status int) commandReply {
	t.Helper()
	select {
	case reply := <-pending.done:
		if reply.err != nil {
			t.Fatalf("incomplete HTTP response: %v; body=%s", reply.err, reply.body)
		}
		if reply.status != status {
			t.Fatalf("HTTP status=%d, want %d: %s", reply.status, status, reply.body)
		}
		return reply
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for complete HTTP response")
		return commandReply{}
	}
}

func (reply commandReply) events(t *testing.T) commandEventReply {
	t.Helper()
	if !strings.HasPrefix(reply.contentType, "application/json") {
		t.Fatalf("event response Content-Type=%q: %s", reply.contentType, reply.body)
	}
	var events commandEventReply
	if err := json.Unmarshal(reply.body, &events); err != nil {
		t.Fatalf("invalid JSON: %v; body=%s", err, reply.body)
	}
	return events
}

func waitCommandHead(t *testing.T, p *commandProcess, path string, want int64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		reply := sendCommandRequest(t, p, "GET", path, "").receive(t, http.StatusOK).events(t)
		if reply.Last != nil && *reply.Last == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("committed head did not reach %d", want)
}

func assertCommandHistory(t *testing.T, p *commandProcess, path string, markers ...byte) {
	t.Helper()
	reply := sendCommandRequest(t, p, "GET", path, "").receive(t, http.StatusOK).events(t)
	if reply.Last == nil || *reply.Last != int64(len(markers)-1) || reply.More == nil || *reply.More || len(reply.Events) != len(markers) {
		t.Fatalf("history was lost, duplicated, or not dense: %+v", reply)
	}
	for i, marker := range markers {
		event := reply.Events[i]
		if event.Seq != int64(i) || event.Nonce != base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{marker}, 12)) ||
			event.CT != base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{marker}, 16)) {
			t.Fatalf("event %d changed or moved: %+v", i, event)
		}
	}
}

// startCommand starts the real command with a fresh database on an unused loopback port.
func startCommand(t *testing.T, args ...string) string {
	t.Helper()
	return startCommandProcess(t, t.TempDir(), args...).origin
}

type commandProcess struct {
	cmd     *exec.Cmd
	origin  string
	done    chan struct{}
	waitErr error
	output  bytes.Buffer
	stopped bool
}

// startCommandProcess starts a disposable command, reusing dir only after its predecessor exits.
func startCommandProcess(t *testing.T, dir string, args ...string) *commandProcess {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	args = append([]string{"-listen=" + addr, "-retention=0"}, args...)
	cmd := exec.CommandContext(ctx, os.Args[0], append([]string{"-test.run=^TestCommandProcess$", "--"}, args...)...)
	cmd.Dir = dir
	// The race runtime's default one-second exit sleep is not server drain time.
	cmd.Env = append(os.Environ(), "MAYFLY_COMMAND_TEST=1", "GORACE="+os.Getenv("GORACE")+" atexit_sleep_ms=0")
	p := &commandProcess{cmd: cmd, origin: "http://" + addr, done: make(chan struct{})}
	cmd.Stdout, cmd.Stderr = &p.output, &p.output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		p.waitErr = cmd.Wait()
		close(p.done)
	}()
	t.Cleanup(func() {
		select {
		case <-p.done:
			if !p.stopped && p.waitErr != nil {
				t.Errorf("command exited unexpectedly: %v\n%s", p.waitErr, p.output.String())
			}
		default:
			p.stop(t, syscall.SIGTERM)
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-p.done:
			t.Fatalf("command exited before listening: %v\n%s", p.waitErr, p.output.String())
		default:
		}
		conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			conn.Close()
			return p
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("command did not start listening")
	return nil
}

// stop measures from sending a real signal until the child has been reaped.
func (p *commandProcess) stop(t *testing.T, signal syscall.Signal) time.Duration {
	t.Helper()
	start := time.Now()
	if err := p.cmd.Process.Signal(signal); err != nil {
		t.Fatal(err)
	}
	p.stopped = true
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		p.cmd.Process.Kill()
		<-p.done
		t.Fatalf("command did not exit within 2s of %s\n%s", signal, p.output.String())
	}
	elapsed := time.Since(start)
	if signal == syscall.SIGKILL {
		status, ok := p.cmd.ProcessState.Sys().(syscall.WaitStatus)
		if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
			t.Fatalf("command was not killed: %v\n%s", p.waitErr, p.output.String())
		}
	} else if p.waitErr != nil {
		t.Fatalf("command exited: %v\n%s", p.waitErr, p.output.String())
	}
	t.Logf("%s to process exit: %v", signal, elapsed)
	return elapsed
}

// TestCommandProcess runs the real entry point in a child test process.
func TestCommandProcess(t *testing.T) {
	if os.Getenv("MAYFLY_COMMAND_TEST") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append(os.Args[:1], os.Args[i+1:]...)
			main()
			os.Exit(0)
		}
	}
	t.Fatal("missing command arguments separator")
}

func command(t *testing.T, dir string, args ...string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], append([]string{"-test.run=^TestCommandProcess$", "--"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "MAYFLY_COMMAND_TEST=1")
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("command did not exit: %v\n%s", ctx.Err(), output)
	}
	return string(output), err
}
