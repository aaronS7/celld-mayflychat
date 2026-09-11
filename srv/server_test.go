package srv

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLongPoll(t *testing.T) {
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	start := time.Now()
	resp, body := a.request(t, "GET", "&since=0&wait=1", nil)
	if rp := a.decodeReply(t, body); resp.StatusCode != 200 || rp.Last != 0 || len(rp.Messages) != 0 || time.Since(start) < 900*time.Millisecond {
		t.Fatalf("timeout: %d %s", resp.StatusCode, body)
	}
	done := make(chan string, 2)
	for range 2 {
		go func() { _, body := a.request(t, "GET", "&since=0&wait=10", nil); done <- body }()
	}
	waitSubscribed(t, s.Store, a.id)
	a.post(t, 0, "wake up")
	for range 2 {
		select {
		case body := <-done:
			if rp := a.decodeReply(t, body); len(rp.Messages) != 1 || rp.Messages[0].Text != "wake up" {
				t.Fatal(body)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("long poll did not wake")
		}
	}
}

func TestServeShutdownDrainsPoll(t *testing.T) {
	s, ts := newTestServer(t, func(s *Server) { s.Retention = 0 })
	id, k := createChannel(t, ts)
	ks, err := ParseK(k)
	if err != nil {
		t.Fatal(err)
	}
	addr := ts.Listener.Addr().String()
	ts.Close()

	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan struct{})
	var serveErr error
	go func() {
		serveErr = s.Serve(ctx, addr)
		close(served)
	}()
	defer func() {
		cancel()
		select {
		case <-served:
		case <-time.After(time.Second):
			t.Error("Serve did not stop")
		}
	}()

	deadline := time.Now().Add(3 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err == nil {
			conn.Close()
			break
		}
		select {
		case <-served:
			t.Fatalf("Serve failed to start: %v", serveErr)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("Serve did not listen")
		}
		time.Sleep(time.Millisecond)
	}

	pollCtx, cancelPoll := context.WithCancel(context.Background())
	defer cancelPoll()
	req, err := http.NewRequestWithContext(pollCtx, "GET", ts.URL+"/c/"+id+"/events?since=-1&wait=86400", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+ks.Auth)
	client := &http.Client{Timeout: 3 * time.Second}
	defer client.CloseIdleConnections()
	polled := make(chan struct{})
	var resp *http.Response
	var body []byte
	var pollErr error
	go func() {
		defer close(polled)
		resp, pollErr = client.Do(req)
		if pollErr != nil {
			return
		}
		defer resp.Body.Close()
		body, pollErr = io.ReadAll(resp.Body)
	}()
	waitSubscribed(t, s.Store, id)
	stopped := time.Now()
	cancel()
	select {
	case <-polled:
		if pollErr != nil {
			t.Fatal(pollErr)
		}
		var rp map[string]any
		if err := json.Unmarshal(body, &rp); err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusServiceUnavailable || rp["error"] != "restarting" || rp["hint"] != "Server restarting; try again shortly." || len(rp) != 2 {
			t.Fatalf("drained poll: %d %s", resp.StatusCode, body)
		}
	case <-time.After(time.Second):
		t.Fatal("poll did not drain")
	}
	select {
	case <-served:
		if serveErr != nil {
			t.Fatal(serveErr)
		}
	case <-time.After(time.Second):
		t.Fatal("Serve did not return after the poll drained")
	}
	t.Logf("held read and server drained in %v", time.Since(stopped))
}

func TestServeOccupiedAddress(t *testing.T) {
	s, ts := newTestServer(t, func(s *Server) { s.Retention = 0 })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	served := make(chan error, 1)
	go func() { served <- s.Serve(ctx, ts.Listener.Addr().String()) }()
	select {
	case err := <-served:
		var opErr *net.OpError
		if !errors.As(err, &opErr) || opErr.Op != "listen" {
			t.Fatalf("Serve on occupied address: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Serve waited for cancellation on an occupied address")
	}
}

func TestCanceledPoll(t *testing.T) {
	s, ts := newTestServer(t)
	a := newSeededChannel(t, ts, "Alpha")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest("GET", a.url("/events?since=0&wait=86400"), nil).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+a.ks.Auth)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		done <- w
	}()
	waitSubscribed(t, s.Store, a.id)
	cancel()
	select {
	case w := <-done:
		if w.Code != 200 || a.decodeReply(t, w.Body.String()).Last != 0 {
			t.Fatalf("canceled wait: %d %s", w.Code, w.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("canceled poll remained blocked")
	}
}

func TestAdmittedPostFinishesDuringRestart(t *testing.T) {
	admitted, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	now := time.Unix(1789000000, 0)
	s, ts := newTestServer(t, func(s *Server) {
		s.Retention = 0
		s.Now = func() time.Time {
			close(admitted) // The POST has passed authentication and body validation.
			<-release
			return now
		}
	})
	ks, err := Derive(NewK())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Store.CreateChannel(ks.ID, AuthHash(ks.Auth), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	blob := sealInner(t, ks, 0, Inner{From: "Fixture", Text: "finish the admitted write"})
	body, _ := json.Marshal(map[string]string{"nonce": b64u(blob.Nonce), "ct": b64u(blob.CT)})
	done := make(chan struct{})
	var response *http.Response
	var raw string
	go func() {
		defer close(done)
		response, raw = do(t, "POST", ts.URL+"/c/"+ks.ID+"/events?last=-1&wait=86400", string(body), bearerHdr(ks.Auth))
	}()
	select {
	case <-admitted:
	case <-time.After(time.Second):
		t.Fatal("post did not reach its write")
	}
	close(s.stopping)
	once.Do(func() { close(release) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("admitted post waited for replies during restart")
	}
	var reply eventReply
	if err := json.Unmarshal([]byte(raw), &reply); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || reply.Posted == nil || !*reply.Posted || reply.ID == nil || *reply.ID != 0 || reply.Last != 0 || reply.More || len(reply.Events) != 0 {
		t.Fatalf("committed write not acknowledged: %d %s", response.StatusCode, raw)
	}
	page, err := s.Store.Events(ks.ID, -1)
	if err != nil || len(page.Events) != 1 || page.Events[0].CT != b64u(blob.CT) {
		t.Fatalf("acknowledgement preceded commit: %+v %v", page, err)
	}
	channel, err := s.Store.Channel(ks.ID)
	if err != nil || !channel.LastActivity.Equal(now) {
		t.Fatalf("append and activity did not commit together: %+v %v", channel, err)
	}
}

func TestRestartRefusesBeforeDatabase(t *testing.T) {
	s, ts := newTestServer(t)
	id, key := createChannel(t, ts)
	ks, err := ParseK(key)
	if err != nil {
		t.Fatal(err)
	}
	creation := creationBody(t)
	conn, err := s.Store.db.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	close(s.stopping)
	before := s.Store.db.Stats().WaitCount
	client := &http.Client{Timeout: time.Second}
	defer client.CloseIdleConnections()
	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/", ""},
		{"GET", "/c/" + id, ""},
		{"GET", "/c/" + id + "/events?since=-1&wait=86400", ""},
		{"POST", "/c/" + id + "/events?last=-1", `{}`},
		{"POST", "/new", creation},
		{"DELETE", "/c/" + id, ""},
	} {
		req, err := http.NewRequest(tc.method, ts.URL+tc.path, strings.NewReader(tc.body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+ks.Auth)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal("restart refusal blocked on the database:", err)
		}
		var reply map[string]any
		err = json.NewDecoder(resp.Body).Decode(&reply)
		resp.Body.Close()
		if err != nil || resp.StatusCode != 503 || reply["error"] != "restarting" || reply["hint"] != "Server restarting; try again shortly." {
			t.Fatalf("refusal: %d %+v %v", resp.StatusCode, reply, err)
		}
		posted, hasPosted := reply["posted"]
		if hasPosted != (tc.method == "POST") || (hasPosted && posted != false) {
			t.Fatalf("refusal claimed the wrong post outcome: %+v", reply)
		}
	}
	// A wait entered after the stop signal must also avoid acquiring the held connection.
	waited := make(chan error, 1)
	go func() {
		_, err := s.Store.WaitEvents(id, -1, time.Hour, nil, s.stopping)
		waited <- err
	}()
	select {
	case err := <-waited:
		if !errors.Is(err, ErrRestarting) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("stopped wait attempted another database read")
	}
	if s.Store.db.Stats().WaitCount != before {
		t.Fatal("refused requests attempted database work")
	}
}
