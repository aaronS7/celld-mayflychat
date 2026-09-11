package srv

import (
	"net"
	"net/http"
	"strings"
)

// clientIP returns the direct peer's IP unless TrustProxy enables X-Forwarded-For.
func (s *Server) clientIP(r *http.Request) string {
	if s.TrustProxy {
		if values := r.Header.Values("X-Forwarded-For"); len(values) > 0 {
			hops := strings.Split(values[len(values)-1], ",")
			if ip := net.ParseIP(strings.TrimSpace(hops[len(hops)-1])); ip != nil {
				return ip.String()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	return ""
}

// baseURL returns the request origin, honoring forwarded headers only with TrustProxy.
func (s *Server) baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if s.TrustProxy {
		if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
			scheme = proto
		}
		if forwardedHost := r.Header.Get("X-Forwarded-Host"); forwardedHost != "" {
			host = forwardedHost
		}
	}
	return scheme + "://" + host
}
