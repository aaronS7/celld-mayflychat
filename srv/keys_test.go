package srv

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

// vector is a shared derivation and encryption fixture from static/vectors.json.
// The Go test participant, standalone clients, and browser check these values.
type vector struct {
	K, ID, Auth, Enc, Nonce, Plaintext, CT string
	Seq                                    int64
	PaddedLen                              int `json:"padded_len"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	raw, err := os.ReadFile("static/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vs []vector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	if len(vs) < 3 {
		t.Fatalf("only %d vectors", len(vs))
	}
	return vs
}

func TestVectors(t *testing.T) {
	for i, v := range loadVectors(t) {
		ks, err := ParseK(v.K)
		if err != nil {
			t.Fatalf("vector %d: %v", i, err)
		}
		if ks.ID != v.ID || ks.Auth != v.Auth || b64u(ks.Enc) != v.Enc {
			t.Errorf("vector %d: derive got id=%s auth=%s enc=%s", i, ks.ID, ks.Auth, b64u(ks.Enc))
		}
		if len(ks.ID) != 22 || len(ks.Auth) != 43 || len(v.K) != 43 {
			t.Errorf("vector %d: lengths id=%d auth=%d K=%d", i, len(ks.ID), len(ks.Auth), len(v.K))
		}
		nonce, _ := unb64u(v.Nonce)
		ct, err := SealWith(ks.Enc, ks.ID, v.Seq, nonce, []byte(v.Plaintext))
		if err != nil {
			t.Fatal(err)
		}
		if b64u(ct) != v.CT {
			t.Errorf("vector %d: seal mismatch\n got %s\nwant %s", i, b64u(ct), v.CT)
		}
		if len(ct) != v.PaddedLen+16 {
			t.Errorf("vector %d: ct len %d, want padded %d + tag", i, len(ct), v.PaddedLen)
		}
		want, _ := unb64u(v.CT)
		pt, err := Open(ks.Enc, ks.ID, v.Seq, nonce, want)
		if err != nil {
			t.Fatalf("vector %d: open: %v", i, err)
		}
		if !bytes.Equal(bytes.TrimRight(pt, " "), []byte(v.Plaintext)) || len(pt) != v.PaddedLen {
			t.Errorf("vector %d: open got %q", i, pt)
		}
		if _, err := Open(ks.Enc, ks.ID, v.Seq+1, nonce, want); err == nil {
			t.Errorf("vector %d: opened at wrong sequence", i)
		}
		// AAD binds the channel id: the same blob fails under another id.
		if _, err := Open(ks.Enc, "wrong-channel-id", v.Seq, nonce, want); err == nil {
			t.Errorf("vector %d: opened under wrong AAD", i)
		}
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	ks, err := Derive(NewK())
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []int{0, 1, 255, 256, 257, 1000, 64 << 10} {
		pt := bytes.Repeat([]byte("a"), n)
		nonce, ct, err := Seal(ks.Enc, ks.ID, 7, pt)
		if err != nil {
			t.Fatal(err)
		}
		wantPad := (n + padTo - 1) / padTo * padTo
		if len(ct) != wantPad+16 {
			t.Errorf("n=%d: ct %d bytes, want %d", n, len(ct), wantPad+16)
		}
		got, err := Open(ks.Enc, ks.ID, 7, nonce, ct)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(bytes.TrimRight(got, " "), pt) {
			t.Errorf("n=%d: round trip mismatch", n)
		}
		for _, seq := range []int64{7, 8} {
			nextNonce, nextCT, err := Seal(ks.Enc, ks.ID, seq, pt)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Equal(nonce, nextNonce) || bytes.Equal(ct, nextCT) {
				t.Fatal("reseal reused nonce or ciphertext")
			}
		}
		// Wrong key, flipped byte: fail.
		other, _ := Derive(NewK())
		if _, err := Open(other.Enc, ks.ID, 7, nonce, ct); err == nil {
			t.Error("opened with wrong key")
		}
		ct[len(ct)/2] ^= 1
		if _, err := Open(ks.Enc, ks.ID, 7, nonce, ct); err == nil {
			t.Error("opened tampered ciphertext")
		}
	}
	if _, err := ParseK("short"); err == nil {
		t.Error("short key accepted")
	}
	if _, err := ParseK("not base64!!"); err == nil {
		t.Error("bad base64 accepted")
	}
}
