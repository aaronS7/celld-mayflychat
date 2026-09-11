package srv

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSourceSelection(t *testing.T) {
	for _, tc := range []struct {
		name, peer, direct, forwarded string
		xff                           []string
	}{
		{"loopback is not trusted", "127.0.0.1:1234", "127.0.0.1", "198.51.100.1", []string{"203.0.113.1, 198.51.100.1"}},
		{"proxy", "192.0.2.1:1234", "192.0.2.1", "198.51.100.1", []string{"203.0.113.1, 198.51.100.1"}},
		{"multiple fields", "192.0.2.1:1234", "192.0.2.1", "198.51.100.2", []string{"203.0.113.1", "198.51.100.1, 198.51.100.2"}},
		{"bad final", "192.0.2.1:1234", "192.0.2.1", "192.0.2.1", []string{"203.0.113.1", "198.51.100.1, not-an-ip"}},
		{"empty final field", "192.0.2.1:1234", "192.0.2.1", "192.0.2.1", []string{"203.0.113.1", ""}},
		{"empty final hop", "192.0.2.1:1234", "192.0.2.1", "192.0.2.1", []string{"203.0.113.1, "}},
		{"missing", "192.0.2.1:1234", "192.0.2.1", "192.0.2.1", nil},
		{"mapped", "192.0.2.1:1234", "192.0.2.1", "198.51.100.1", []string{" ::ffff:198.51.100.1 "}},
		{"forwarded IPv6", "192.0.2.1:1234", "192.0.2.1", "2001:db8::2", []string{"203.0.113.1, 2001:0db8::2 "}},
		{"peer IPv6", "[2001:0db8::1]:1234", "2001:db8::1", "2001:db8::1", nil},
		{"bare peer IPv6", "2001:0db8::1", "2001:db8::1", "2001:db8::1", []string{"bad"}},
		{"invalid peer", "not-an-ip", "", "", []string{"bad"}},
	} {
		for _, trust := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/trust=%v", tc.name, trust), func(t *testing.T) {
				s := &Server{TrustProxy: trust}
				r := httptest.NewRequest("GET", "http://example.test/", nil)
				r.RemoteAddr = tc.peer
				r.Header["X-Forwarded-For"] = tc.xff
				want := tc.direct
				if trust {
					want = tc.forwarded
				}
				if got := s.clientIP(r); got != want {
					t.Fatalf("source: %q, want %q", got, want)
				}
			})
		}
	}
}

func TestSourceQuotaTrust(t *testing.T) {
	for _, trust := range []bool{false, true} {
		t.Run(fmt.Sprintf("trust=%v", trust), func(t *testing.T) {
			now := time.Unix(1700000000, 0)
			s, ts := newTestServer(t, func(s *Server) {
				s.TrustProxy = trust
				s.Now = func() time.Time { return now }
			})
			client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			create := func(xff []string, identity string) int {
				t.Helper()
				r, err := http.NewRequest("POST", ts.URL+"/new", strings.NewReader(creationBody(t)))
				if err != nil {
					t.Fatal(err)
				}
				r.Header["X-Forwarded-For"] = xff
				r.Header.Set("X-Forwarded-User", identity)
				resp, err := client.Do(r)
				if err != nil {
					t.Fatal(err)
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				return resp.StatusCode
			}
			// Earlier fields and hops cannot split the observed-IP bucket.
			for i := 0; i <= creationBurst; i++ {
				xff := []string{fmt.Sprintf("192.0.2.%d", i), fmt.Sprintf("198.51.100.%d, 203.0.113.1", i)}
				want := http.StatusSeeOther
				if i == creationBurst {
					want = http.StatusTooManyRequests
				}
				if got := create(xff, fmt.Sprint(i)); got != want {
					t.Fatalf("shared observed IP create %d: %d want %d", i, got, want)
				}
			}
			// Different final IPs get separate buckets only after explicit proxy opt-in.
			for i := 0; i <= creationBurst; i++ {
				want := http.StatusTooManyRequests
				if trust {
					want = http.StatusSeeOther
				}
				forwarded := fmt.Sprintf("198.51.100.%d", i)
				if i == creationBurst {
					forwarded = "2001:0db8::1"
				}
				if got := create([]string{forwarded}, "same-user"); got != want {
					t.Fatalf("different forwarded IP create %d: %d want %d", i, got, want)
				}
			}
			// Missing or invalid final values all fall back to the direct peer's bucket.
			fallbacks := [][]string{nil, {"198.51.100.222", "bad"}, {"198.51.100.222", ""}}
			for _, xff := range fallbacks {
				want := http.StatusTooManyRequests
				if trust {
					want = http.StatusSeeOther
				}
				if got := create(xff, "same-user"); got != want {
					t.Fatalf("peer fallback create: %d want %d", got, want)
				}
			}
			ip, count := "127.0.0.1", 1
			if trust {
				ip, count = "203.0.113.1", creationBurst+3
			}
			s.quota.mu.Lock()
			defer s.quota.mu.Unlock()
			if len(s.quota.buckets) != count || s.quota.buckets[ip].tokens != 0 {
				t.Fatalf("IP buckets: %+v", s.quota.buckets)
			}
			if trust && s.quota.buckets["2001:db8::1"].tokens != creationBurst-1 {
				t.Fatal("forwarded IPv6 did not get its own canonical bucket")
			}
			for source, bucket := range s.quota.buckets {
				want := float64(creationBurst - 1)
				if source == "127.0.0.1" {
					want = float64(creationBurst - len(fallbacks))
				}
				if source != ip && bucket.tokens != want {
					t.Fatalf("separate bucket %s: %+v", source, bucket)
				}
			}
		})
	}
}

func TestCreationCrossOrigin(t *testing.T) {
	s, ts := newTestServer(t)
	for _, valid := range []bool{true, false} {
		for _, tc := range []struct {
			name, site, origin string
			allowed            bool
		}{
			{"non-browser", "", "", true},
			{"same-origin-fetch", "same-origin", ts.URL, true},
			{"same-origin-origin", "", ts.URL, true},
			{"cross-site-fetch", "cross-site", "https://other.test", false},
			{"same-site-fetch", "same-site", "https://other.test", false},
			{"cross-site-origin", "", "https://other.test", false},
		} {
			t.Run(fmt.Sprint(tc.name, valid), func(t *testing.T) {
				body := creationBody(t)
				if !valid {
					body = `{"id":"invalid"}`
				}
				var before, after int
				s.Store.db.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&before)
				h := map[string]string{"Sec-Fetch-Site": tc.site, "Origin": tc.origin}
				resp, result := do(t, "POST", ts.URL+"/new", body, h)
				want := 403
				if tc.allowed {
					want = 303
					if !valid {
						want = 400
					}
				}
				if resp.StatusCode != want {
					t.Fatalf("creation origin: %d, want %d: %s", resp.StatusCode, want, result)
				}
				s.Store.db.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&after)
				if !tc.allowed && before != after {
					t.Fatal("rejected origin created a channel")
				}
			})
		}
	}
}

// TestIdentityHeadersIgnored checks that identity headers an upstream proxy
// might add (X-Forwarded-Email, X-Forwarded-User) and any claimed sender name
// buy nothing: pages, creation, and the IP quota are identical with and
// without them, whether or not the proxy is trusted.
func TestIdentityHeadersIgnored(t *testing.T) {
	for _, trust := range []bool{false, true} {
		t.Run(fmt.Sprintf("trust=%v", trust), func(t *testing.T) {
			s, ts := newTestServer(t, func(s *Server) { s.TrustProxy = trust })
			id, _ := createChannel(t, ts)
			_, anonymousIndex := do(t, "GET", ts.URL+"/", "", nil)
			_, anonymousView := do(t, "GET", ts.URL+"/c/"+id, "", htmlHdr())
			headers := map[string]string{
				"X-Forwarded-Email": "person@example.test",
				"X-Forwarded-User":  "claimed-user",
				"X-Claimed-Name":    "claimed-name",
			}
			resp, index := do(t, "GET", ts.URL+"/", "", headers)
			if resp.StatusCode != 200 || withoutNonces(index) != withoutNonces(anonymousIndex) || indexButtonDisabled(t, index) {
				t.Fatal("identity changed public index", resp.StatusCode)
			}
			resp, _ = do(t, "POST", ts.URL+"/new", creationBody(t), headers)
			if resp.StatusCode != 303 {
				t.Fatalf("public creation: %d", resp.StatusCode)
			}
			resp, view := do(t, "GET", ts.URL+"/c/"+id, "", htmlHdr(headers))
			if resp.StatusCode != 200 || withoutNonces(view) != withoutNonces(anonymousView) {
				t.Fatal("identity changed anonymous view", resp.StatusCode)
			}
			s.quota.mu.Lock()
			defer s.quota.mu.Unlock()
			if len(s.quota.buckets) != 1 {
				t.Fatalf("identity headers split the IP quota: %+v", s.quota.buckets)
			}
		})
	}
}

func TestOriginSelection(t *testing.T) {
	for _, tc := range []struct {
		name              string
		trust, tls        bool
		proto, host, want string
	}{
		{"direct HTTP", false, false, "", "", "http://direct.example.test:8443"},
		{"direct HTTPS", false, true, "", "", "https://direct.example.test:8443"},
		{"default ignores spoofed origin", false, false, "https", "forwarded.example.test", "http://direct.example.test:8443"},
		{"default ignores spoofed downgrade", false, true, "http", "forwarded.example.test", "https://direct.example.test:8443"},
		{"trusted HTTP fallback", true, false, "", "", "http://direct.example.test:8443"},
		{"trusted HTTPS fallback", true, true, "", "", "https://direct.example.test:8443"},
		{"trusted origin", true, false, "https", "forwarded.example.test", "https://forwarded.example.test"},
		{"trusted proto overrides TLS", true, true, "http", "forwarded.example.test", "http://forwarded.example.test"},
		{"trusted proto only", true, false, "https", "", "https://direct.example.test:8443"},
		{"trusted host only", true, false, "", "forwarded.example.test", "http://forwarded.example.test"},
		{"trusted host with TLS", true, true, "", "forwarded.example.test", "https://forwarded.example.test"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{TrustProxy: tc.trust}
			// URL fields do not establish the connection's scheme or request Host.
			r := httptest.NewRequest("GET", "https://url.example.test/c/test", nil)
			r.Host = "direct.example.test:8443"
			if !tc.tls {
				r.TLS = nil
			}
			r.Header.Set("X-Forwarded-Proto", tc.proto)
			r.Header.Set("X-Forwarded-Host", tc.host)
			if got := s.baseURL(r); got != tc.want {
				t.Fatalf("origin: %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPostingSourceMetadata(t *testing.T) {
	for _, trust := range []bool{false, true} {
		t.Run(fmt.Sprintf("trust=%v", trust), func(t *testing.T) {
			s, ts := newTestServer(t, func(s *Server) { s.TrustProxy = trust })
			a := newSeededChannel(t, ts, "Alpha")
			for i, tc := range []struct {
				peer, direct, forwarded string
				xff                     []string
			}{
				{"127.0.0.1:1234", "127.0.0.1", "198.51.100.8", []string{"203.0.113.7, 198.51.100.8"}},
				{"192.0.2.2:1234", "192.0.2.2", "198.51.100.10", []string{"203.0.113.7", "198.51.100.9, 198.51.100.10"}},
				{"192.0.2.3:1234", "192.0.2.3", "2001:db8::2", []string{"203.0.113.7", "2001:0db8::2"}},
				{"[2001:0db8::1]:1234", "2001:db8::1", "2001:db8::1", []string{"203.0.113.7, bad"}},
				{"192.0.2.4:1234", "192.0.2.4", "192.0.2.4", []string{"203.0.113.7", ""}},
				{"192.0.2.5:1234", "192.0.2.5", "192.0.2.5", nil},
			} {
				want := tc.direct
				if trust {
					want = tc.forwarded
				}
				blob := sealInner(t, a.ks, int64(i+1), Inner{From: a.name, Text: "source"})
				body, _ := json.Marshal(map[string]string{"nonce": b64u(blob.Nonce), "ct": b64u(blob.CT), "src": "spoofed-source"})
				r := httptest.NewRequest("POST", a.url("/events?last="+itoa(i)), bytes.NewReader(body))
				r.RemoteAddr = tc.peer
				r.Header.Set("Authorization", "Bearer "+a.ks.Auth)
				r.Header["X-Forwarded-For"] = tc.xff
				r.Header.Set("X-Claimed-Name", "spoofed-name")
				w := httptest.NewRecorder()
				s.Handler().ServeHTTP(w, r)
				if w.Code != 200 {
					t.Fatalf("source post: %d %s", w.Code, w.Body.String())
				}
				got := a.read(t, i).Messages
				if len(got) != 1 || got[0].Src != want || got[0].From != a.name {
					t.Fatalf("server source: %+v want %s", got, want)
				}
				var stored string
				if err := s.Store.db.QueryRow(`SELECT src FROM events WHERE channel_id=? AND seq=?`, a.id, i+1).Scan(&stored); err != nil || stored != want {
					t.Fatalf("stored source: %s %v", stored, err)
				}
			}
		})
	}
}
