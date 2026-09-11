package srv

import (
	"fmt"
	"maps"
	"sync"
	"testing"
	"time"
)

func TestCreateQuota(t *testing.T) {
	now := time.Unix(1700000000, 0)
	s, ts := newTestServer(t, func(s *Server) { s.Now = func() time.Time { return now } })
	for range creationBurst - 1 {
		createChannel(t, ts)
	}
	var wg sync.WaitGroup
	codes := make(chan int, 16)
	for range 16 {
		wg.Go(func() { resp, _ := do(t, "POST", ts.URL+"/new", creationBody(t), nil); codes <- resp.StatusCode })
	}
	wg.Wait()
	close(codes)
	wins := 0
	for code := range codes {
		if code == 303 {
			wins++
		} else if code != 429 {
			t.Fatal(code)
		}
	}
	if wins != 1 {
		t.Fatalf("quota: %d extra creates", wins)
	}
	// Neither claimed identity nor forged forwarding headers buy another bucket.
	for _, h := range []map[string]string{
		{"X-Forwarded-Email": "person@example.test"},
		{"X-Forwarded-For": "198.51.100.2", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "other.example.test"},
	} {
		if resp, _ := do(t, "POST", ts.URL+"/new", creationBody(t), h); resp.StatusCode != 429 {
			t.Fatal(resp.StatusCode)
		}
	}
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	if len(s.quota.buckets) != 1 || s.quota.buckets["127.0.0.1"].tokens != 0 {
		t.Fatalf("IP buckets: %+v", s.quota.buckets)
	}
}

func TestVolatileIPQuota(t *testing.T) {
	s, _ := newTestServer(t)
	quota := s.quota
	var next int
	create := func(ip string, at time.Time) error {
		next++
		id := fmt.Sprintf("quota-%d", next)
		return quota.charge(ip, at, func() error { return s.Store.CreateChannel(id, []byte{1}, at) })
	}
	now := time.Unix(1700000000, 0)
	for range creationBurst {
		if err := create("one", now); err != nil {
			t.Fatal(err)
		}
	}
	before := maps.Clone(quota.buckets)
	for _, at := range []time.Time{now, now.Add(creationRefill / 2), now.Add(creationRefill - time.Nanosecond)} {
		if err := create("one", at); err != ErrTooManyChans {
			t.Fatalf("before refill at %v: %v", at, err)
		}
		if !maps.Equal(before, quota.buckets) {
			t.Fatal("rejection mutated the bucket")
		}
	}
	// An exhausted IP is refused before storage is consulted, duplicates included.
	duplicate := func(ip string) error {
		return quota.charge(ip, now, func() error { return s.Store.CreateChannel("quota-1", []byte{1}, now) })
	}
	if err := duplicate("one"); err != ErrTooManyChans {
		t.Fatalf("exhausted duplicate: %v", err)
	}
	if !maps.Equal(before, quota.buckets) {
		t.Fatal("duplicate charged quota")
	}
	if err := create("other", now); err != nil {
		t.Fatal(err)
	}
	// A duplicate ID fails inside creation and spends nothing.
	if err := duplicate("other"); err != ErrExists || quota.buckets["other"].tokens != creationBurst-1 {
		t.Fatalf("duplicate with credit: %v %+v", err, quota.buckets["other"])
	}
	// Refill is continuous, not a new daily window. Fractional tokens survive spending.
	at := now.Add(creationRefill + creationRefill/2)
	if err := create("one", at); err != nil {
		t.Fatalf("refill: %v", err)
	}
	if got := quota.buckets["one"]; got.tokens != 0.5 || !got.updated.Equal(at) {
		t.Fatalf("fractional refill: %+v", got)
	}
	if err := create("one", now.Add(2*creationRefill-time.Nanosecond)); err != ErrTooManyChans {
		t.Fatalf("fractional token spent early: %v", err)
	}
	if err := create("one", now.Add(2*creationRefill)); err != nil || quota.buckets["one"].tokens != 0 {
		t.Fatalf("second token: %v %+v", err, quota.buckets["one"])
	}
	quota = newCreationQuota()
	if err := create("one", now); err != nil || quota.buckets["one"].tokens != creationBurst-1 {
		t.Fatalf("fresh quota: %v", err)
	}
}

func TestIPQuotaClockAndCapacity(t *testing.T) {
	s, _ := newTestServer(t)
	quota := s.quota
	now := time.Unix(1700000000, 0)
	create := func(n int, at time.Time) error {
		return quota.charge("one", at, func() error { return s.Store.CreateChannel(fmt.Sprint(n), []byte{1}, at) })
	}
	if err := create(0, now); err != nil {
		t.Fatal(err)
	}
	future := now.Add(365 * 24 * time.Hour)
	if err := create(1, future); err != nil || quota.buckets["one"].tokens != creationBurst-1 {
		t.Fatalf("idle refill exceeds burst: %v %+v", err, quota.buckets["one"])
	}
	// Existing credits remain spendable during clock rollback, without rewinding refill time.
	for i := 2; i <= creationBurst; i++ {
		if err := create(i, now); err != nil {
			t.Fatal(err)
		}
	}
	if got := quota.buckets["one"]; got.tokens != 0 || !got.updated.Equal(future) {
		t.Fatalf("backwards clock: %+v", got)
	}
	for i, at := range []time.Time{now, future, future.Add(creationRefill - time.Nanosecond)} {
		if err := create(1000+i, at); err != ErrTooManyChans {
			t.Fatalf("clock minted tokens at %v: %v", at, err)
		}
	}
	if err := create(2000, future.Add(creationRefill)); err != nil {
		t.Fatalf("refill after clock catches up: %v", err)
	}
}

func TestIPQuotaBoundAndFailures(t *testing.T) {
	s, _ := newTestServer(t)
	quota := s.quota
	var next int
	create := func(ip string, at time.Time) error {
		next++
		id := fmt.Sprintf("quota-%d", next)
		return quota.charge(ip, at, func() error { return s.Store.CreateChannel(id, []byte{1}, at) })
	}
	now := time.Unix(1700000000, 0)
	for i := 0; i < maxQuotaIPs; i++ {
		if err := create(fmt.Sprint(i), now); err != nil {
			t.Fatal(err)
		}
	}
	before := maps.Clone(quota.buckets)
	if err := quota.charge("new", now, func() error { return s.Store.CreateChannel("quota-1", []byte{1}, now) }); err != ErrExists {
		t.Fatalf("full-map duplicate: %v", err)
	}
	if !maps.Equal(before, quota.buckets) {
		t.Fatal("duplicate evicted an IP")
	}
	// Neither insert nor commit failures may charge/refill existing IPs or evict for new IPs.
	for _, tc := range []struct{ name, setup, cleanup string }{
		{"insert", `CREATE TRIGGER fail_create BEFORE INSERT ON channels BEGIN SELECT RAISE(ABORT, 'test failure'); END`, `DROP TRIGGER fail_create`},
		{"commit", `CREATE TABLE quota_failure (id TEXT REFERENCES channels(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TRIGGER fail_commit AFTER INSERT ON channels BEGIN INSERT INTO quota_failure VALUES ('missing'); END`, `DROP TRIGGER fail_commit; DROP TABLE quota_failure`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.Store.db.Exec(tc.setup); err != nil {
				t.Fatal(err)
			}
			for _, ip := range []string{"0", "new"} {
				if err := create(ip, now.Add(24*time.Hour)); err == nil {
					t.Fatal("creation unexpectedly succeeded")
				}
				if !maps.Equal(before, quota.buckets) {
					t.Fatal("failed transaction changed buckets")
				}
				var count int
				if err := s.Store.db.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&count); err != nil || count != maxQuotaIPs {
					t.Fatalf("failed transaction inserted channel: %d %v", count, err)
				}
			}
			if _, err := s.Store.db.Exec(tc.cleanup); err != nil {
				t.Fatal(err)
			}
		})
	}
	// A tracked IP at capacity must not evict another IP.
	if err := create("0", now); err != nil {
		t.Fatal(err)
	}
	before["0"] = creationBucket{tokens: creationBurst - 2, updated: now}
	if !maps.Equal(before, quota.buckets) {
		t.Fatal("tracked creation changed another bucket")
	}
	if err := create("new", now); err != nil {
		t.Fatal(err)
	}
	if len(quota.buckets) != maxQuotaIPs || quota.buckets["new"].tokens != creationBurst-1 {
		t.Fatal("IP bound/install")
	}
	victim := ""
	missing := 0
	for ip, bucket := range before {
		got, ok := quota.buckets[ip]
		if !ok {
			victim = ip
			missing++
		} else if got != bucket {
			t.Fatal("eviction changed a surviving bucket")
		}
	}
	if missing != 1 {
		t.Fatalf("evicted %d IPs", missing)
	}
	if err := create(victim, now); err != nil {
		t.Fatal(err)
	}
	if len(quota.buckets) != maxQuotaIPs || quota.buckets[victim].tokens != creationBurst-1 {
		t.Fatal("evicted bucket did not reset")
	}
	var count int
	if err := s.Store.db.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&count); err != nil || count != maxQuotaIPs+3 {
		t.Fatalf("successful channels: %d %v", count, err)
	}
	before = maps.Clone(quota.buckets)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := create("begin-failure", now); err == nil || !maps.Equal(before, quota.buckets) {
		t.Fatal("failed Begin changed buckets", err)
	}
}

func TestConcurrentIPQuota(t *testing.T) {
	s, _ := newTestServer(t)
	now := time.Unix(1700000000, 0)
	results := make(chan error, 120)
	for i := 0; i < 120; i++ {
		go func() {
			results <- s.quota.charge("same", now, func() error { return s.Store.CreateChannel(fmt.Sprintf("concurrent-%d", i), []byte{1}, now) })
		}()
	}
	successes := 0
	for i := 0; i < 120; i++ {
		switch err := <-results; err {
		case nil:
			successes++
		case ErrTooManyChans:
		default:
			t.Fatalf("unexpected create failure: %v", err)
		}
	}
	if successes != 100 || s.quota.buckets["same"].tokens != 0 {
		t.Fatalf("concurrent successes: %d", successes)
	}
	var count int
	if err := s.Store.db.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&count); err != nil || count != 100 {
		t.Fatalf("committed channels: %d %v", count, err)
	}
}
