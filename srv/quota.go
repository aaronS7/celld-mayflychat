package srv

import (
	"errors"
	"math/rand/v2"
	"sync"
	"time"
)

const (
	creationBurst  = 100
	maxQuotaIPs    = 4096
	creationRefill = 24 * time.Hour / creationBurst
)

var ErrTooManyChans = errors.New("channel creation rate limit reached")

// creationQuota is the in-memory, per-IP token bucket that bounds channel
// creation. It knows nothing about storage: charge wraps whatever actually
// creates the channel and spends a token only when that succeeds.
type creationQuota struct {
	mu      sync.Mutex
	buckets map[string]creationBucket
}

type creationBucket struct {
	tokens  float64
	updated time.Time
}

func newCreationQuota() *creationQuota {
	return &creationQuota{buckets: make(map[string]creationBucket)}
}

// charge runs create if ip has a token and spends the token only if create
// succeeds. The lock is held across create so concurrent requests from one
// IP cannot overspend; an exhausted IP gets ErrTooManyChans without create
// running at all.
func (q *creationQuota) charge(ip string, now time.Time, create func() error) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	bucket, tracked := q.buckets[ip]
	if !tracked {
		bucket = creationBucket{tokens: creationBurst, updated: now}
	} else if now.After(bucket.updated) {
		bucket.tokens = min(creationBurst, bucket.tokens+float64(now.Sub(bucket.updated))/float64(creationRefill))
		bucket.updated = now // Never move backwards and refill the same interval twice.
	}
	if bucket.tokens < 1 {
		return ErrTooManyChans
	}
	if err := create(); err != nil {
		return err
	}
	// Only a committed creation may charge, install, or evict a bucket.
	if !tracked && len(q.buckets) >= maxQuotaIPs {
		victim := rand.IntN(len(q.buckets))
		for key := range q.buckets {
			if victim == 0 {
				delete(q.buckets, key)
				break
			}
			victim--
		}
	}
	bucket.tokens--
	q.buckets[ip] = bucket
	return nil
}
