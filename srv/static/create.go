//go:build ignore

// Create a Mayfly Chat channel locally. Go 1.24+ (stdlib only).
//
//	go run create.go HTTP(S)-ORIGIN
//
// Prints one full channel URL on success; no state or retries.
package main

import (
	"bytes"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const usage = "go run create.go HTTP(S)-ORIGIN"

var originForm = regexp.MustCompile(`(?i)^https?://[^/?#\\\x00-\x1f]+/?$`)

func origin(raw string) (*url.URL, string, error) {
	control := func(r rune) bool { return r < 0x20 || r == 0x7f }
	if raw == "" || strings.Contains(raw, `\`) || strings.IndexFunc(raw, control) >= 0 || !originForm.MatchString(raw) {
		return nil, "", errors.New("expected an HTTP(S) origin with no path, query, or fragment")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, "", errors.New("invalid URL (scheme, host, or port)")
	}
	scheme := strings.ToLower(u.Scheme)
	if (scheme != "http" && scheme != "https") || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || strings.HasSuffix(u.Host, ":") {
		return nil, "", errors.New("expected an HTTP(S) origin with no path, query, or fragment")
	}
	port := u.Port()
	portNumber := uint64(0)
	if port != "" {
		portNumber, err = strconv.ParseUint(port, 10, 16)
		if err != nil {
			return nil, "", errors.New("invalid URL port")
		}
		port = strconv.FormatUint(portNumber, 10)
	}
	host := strings.ToLower(u.Hostname())
	if port != "" && port != map[string]string{"http": "80", "https": "443"}[scheme] {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return u, scheme + "://" + host, nil
}

func run(args []string) error {
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Fprintln(os.Stdout, usage)
		return nil
	}
	if len(args) != 1 {
		return errors.New(usage)
	}
	u, base, err := origin(args[0])
	if err != nil {
		return err
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return err
	}
	derive := func(label string, length int) ([]byte, error) {
		return hkdf.Key(sha256.New, key, []byte{}, label, length)
	}
	idKey, err := derive("mayfly id", 16)
	if err != nil {
		return err
	}
	authKey, err := derive("mayfly auth", 32)
	if err != nil {
		return err
	}
	id, auth := base64.RawURLEncoding.EncodeToString(idKey), base64.RawURLEncoding.EncodeToString(authKey)
	hash := sha256.Sum256([]byte(auth))
	body, err := json.Marshal(map[string]string{"id": id, "auth_hash": base64.RawURLEncoding.EncodeToString(hash[:])})
	if err != nil {
		return err
	}
	endpoint := *u
	endpoint.Path, endpoint.RawPath, endpoint.RawQuery, endpoint.Fragment = "/new", "", "", ""
	req, err := http.NewRequest(http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{DisableKeepAlives: true, DisableCompression: true,
		TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{}}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if _, err := io.Copy(io.Discard, res.Body); err != nil {
		return err
	}
	if res.StatusCode == http.StatusServiceUnavailable {
		return errors.New("HTTP 503: Server temporarily unavailable; try again shortly.")
	}
	if res.StatusCode != http.StatusSeeOther {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	fmt.Printf("%s/c/%s#%s\n", base, id, base64.RawURLEncoding.EncodeToString(key))
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "create:", err)
		os.Exit(1)
	}
}
