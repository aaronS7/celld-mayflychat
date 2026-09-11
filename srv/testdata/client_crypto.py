import json, sys
sys.path.insert(0, sys.argv[1])
import client

for v in json.load(open(sys.argv[2])):
    url = "https://example.test/c/" + v["id"] + "#" + v["K"]
    p, ident, auth, aes = client.keys(url)
    assert ident == v["id"] and auth == v["auth"], v["id"]
    # Only the channel URL identifies a capability.
    try:
        client.keys("https://example.test/c/" + v["id"] + "/view#" + v["K"])
    except ValueError:
        pass
    else:
        raise AssertionError("accepted an unsupported channel path")
    plain = aes.decrypt(client.unb64(v["nonce"]), client.unb64(v["ct"]), f'{ident}:{v["seq"]}'.encode())
    assert plain.rstrip(b" ").decode() == v["plaintext"] and len(plain) == v["padded_len"]
    event = {"seq": v["seq"], "ts": "2026-01-01T00:00:00Z", "src": "198.51.100.7",
             "nonce": v["nonce"], "ct": v["ct"]}
    row = client.render(aes, ident, event)
    if not v["plaintext"]:
        # A vector with no inner content: authenticated, still unbelievable.
        assert row["text"] == "(invalid message)" and row["from"] == "", row
        continue
    inner = json.loads(v["plaintext"])
    assert row == {"id": v["seq"], "ts": event["ts"], "src": event["src"],
                   "from": inner["from"], "text": inner["text"]}, row
    # AAD binds channel and position: same bytes at another seq stay closed.
    assert client.render(aes, ident, dict(event, seq=v["seq"] + 1))["text"] == "(undecryptable message)"
    assert client.render(aes, "AAAAAAAAAAAAAAAAAAAAAA", event)["text"] == "(undecryptable message)"
    for bad in ("", "!!", client.b64(b"short")):
        assert client.render(aes, ident, dict(event, nonce=bad))["text"] == "(undecryptable message)"
    # Fresh seals never repeat a nonce or ciphertext, and open at their own seq.
    a = client.seal(aes, ident, v["seq"], inner)
    b = client.seal(aes, ident, v["seq"], inner)
    c = client.seal(aes, ident, v["seq"] + 1, inner)
    assert a["nonce"] != b["nonce"] and a["ct"] != b["ct"]
    assert a["nonce"] != c["nonce"] and a["ct"] != c["ct"]
    assert len(client.unb64(a["ct"])) % 256 == 16
    for blob, seq in ((a, v["seq"]), (b, v["seq"]), (c, v["seq"] + 1)):
        assert client.render(aes, ident, dict(event, seq=seq, **blob)) == \
            {"id": seq, "ts": event["ts"], "src": event["src"], "from": inner["from"], "text": inner["text"]}

# Authenticated but unbelievable inner content is visible, in place, as such.
p, ident, auth, aes = client.keys("https://example.test/c/" + json.load(open(sys.argv[2]))[0]["id"] + "#" + json.load(open(sys.argv[2]))[0]["K"])
import secrets
def raw(seq, payload):
    nonce = secrets.token_bytes(12)
    padded = payload + b" " * (-len(payload) % 256)
    return {"seq": seq, "ts": "2026-01-01T00:00:00Z", "src": "198.51.100.7",
            "nonce": client.b64(nonce),
            "ct": client.b64(aes.encrypt(nonce, padded, f"{ident}:{seq}".encode()))}
for payload in [b"7", b"[]", b'"text"', b"{}", b"null", b'{"from":7,"text":"x"}',
                b'{"from":"A","text":[]}', b'{"from":null,"text":"x"}',
                b'{"from":" pad ","text":"x"}', b'{"from":"a\\u0000b","text":"x"}',
                b'{"from":"","text":"x"}', b"not json", b"\xff\xfe"]:
    row = client.render(aes, ident, raw(5, payload))
    assert row["text"] == "(invalid message)" and row["from"] == "", (payload, row)
row = client.render(aes, ident, raw(5, '{"from":"é你好🐋","text":""}'.encode()))
assert row == {"id": 5, "ts": "2026-01-01T00:00:00Z", "src": "198.51.100.7", "from": "é你好🐋", "text": ""}, row

# Names have a grammar, not a byte budget.
for name in ("x" * 513, "é" * 512, "a b", "é", "🐋 x"):
    assert client.valid_from(name), name
for name in ("", " pad", "pad ", "two\nlines", "bad\x7fname", "\u0000", 7, None, b"bytes"):
    assert not client.valid_from(name), repr(name)

# URLs that cannot be a channel capability are refused before any I/O.
K = json.load(open(sys.argv[2]))[0]["K"]
ident0 = json.load(open(sys.argv[2]))[0]["id"]
bad = ["https://example.test/c/" + ident0,                      # no fragment
       "https://example.test/c/" + ident0 + "#" + K[:-1],       # short key
       "https://example.test/c/" + ident0 + "#" + K + "A",      # long key
       "https://example.test/c/" + ident0 + "#not base64!",
       "https://example.test/c/AAAAAAAAAAAAAAAAAAAAAA#" + K,    # key is not this channel
       "https://example.test/c/" + ident0 + "/events#" + K,     # not a channel URL
       "https://example.test/" + ident0 + "#" + K,
       "https://example.test/c/" + ident0 + "?x=1#" + K,        # query
       "https://user:pw@example.test/c/" + ident0 + "#" + K,    # credentials
       "ftp://example.test/c/" + ident0 + "#" + K,
       "/c/" + ident0 + "#" + K,
       "https://example.test:notaport/c/" + ident0 + "#" + K]
for url in bad:
    try:
        client.keys(url)
    except ValueError:
        continue
    raise AssertionError(url)
print("ok")
