package srv

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	crand "crypto/rand"
	"crypto/sha256"
	"errors"
	"strconv"
	"strings"
)

// Keys is everything derived from a channel key K.
type Keys struct {
	ID   string // 22 chars base64url: the channel id in the URL path
	Auth string // 43 chars base64url: the event API's bearer
	Enc  []byte // 32 bytes: the AES-256-GCM key
}

// NewK returns a fresh random channel key.
func NewK() []byte {
	k := make([]byte, kLen)
	crand.Read(k)
	return k
}

// Derive computes the channel's keys from K.
func Derive(k []byte) (Keys, error) {
	if len(k) != kLen {
		return Keys{}, errors.New("key must be 32 bytes")
	}
	id, err := hkdf.Key(sha256.New, k, nil, infoID, idLen)
	if err != nil {
		return Keys{}, err
	}
	auth, err := hkdf.Key(sha256.New, k, nil, infoAuth, kLen)
	if err != nil {
		return Keys{}, err
	}
	enc, err := hkdf.Key(sha256.New, k, nil, infoEnc, kLen)
	if err != nil {
		return Keys{}, err
	}
	return Keys{ID: b64u(id), Auth: b64u(auth), Enc: enc}, nil
}

// ParseK decodes the URL-fragment form of K and derives its keys.
func ParseK(s string) (Keys, error) {
	k, err := unb64u(s)
	if err != nil {
		return Keys{}, errors.New("key is not base64url")
	}
	return Derive(k)
}

func gcm(enc []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(enc)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Pad appends spaces to bring plaintext to a multiple of padTo bytes.
func Pad(plaintext []byte) []byte {
	n := (-len(plaintext)) % padTo
	if n < 0 {
		n += padTo
	}
	return append(plaintext, []byte(strings.Repeat(" ", n))...)
}

// Seal encrypts padded plaintext for id and seq with a fresh random nonce.
// The test participant uses it for real relay requests.
func Seal(enc []byte, id string, seq int64, plaintext []byte) (nonce, ct []byte, err error) {
	nonce = make([]byte, nonceLen)
	crand.Read(nonce)
	ct, err = SealWith(enc, id, seq, nonce, plaintext)
	return nonce, ct, err
}

// SealWith encrypts with a supplied nonce for deterministic test vectors.
func SealWith(enc []byte, id string, seq int64, nonce, plaintext []byte) ([]byte, error) {
	if len(nonce) != nonceLen {
		return nil, errors.New("nonce must be 12 bytes")
	}
	g, err := gcm(enc)
	if err != nil {
		return nil, err
	}
	return g.Seal(nil, nonce, Pad(plaintext), []byte(id+":"+strconv.FormatInt(seq, 10))), nil
}

// Open decrypts a blob sealed for id and seq.
// The result may carry trailing-space padding; JSON decoders ignore it.
func Open(enc []byte, id string, seq int64, nonce, ct []byte) ([]byte, error) {
	if len(nonce) != nonceLen {
		return nil, errors.New("nonce must be 12 bytes")
	}
	g, err := gcm(enc)
	if err != nil {
		return nil, err
	}
	return g.Open(nil, nonce, ct, []byte(id+":"+strconv.FormatInt(seq, 10)))
}

const (
	infoID   = "mayfly id"
	infoAuth = "mayfly auth"
	infoEnc  = "mayfly enc"
	kLen     = 32
	padTo    = 256
)
