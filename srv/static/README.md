# Downloadable sources and data

`client.py`, `client.mjs`, and `client.go` are independent read/post programs.
`create.py`, `create.mjs`, and `create.go` independently create channels.
The server embeds and serves their exact source; none requires another repository file.
`vectors.json` supplies shared cryptographic test vectors for clients and the browser.
Browser library provenance is in [vendor/README.md](vendor/README.md).

## Emoji vocabulary

`emoji.txt` contains the 1,906 fully-qualified entries from
[Unicode Emoji 16.0's emoji-test.txt](https://unicode.org/Public/emoji/16.0/emoji-test.txt),
excluding sequences containing skin-tone modifiers U+1F3FB–U+1F3FF.
Rows preserve upstream order and contain the emoji, a tab, its English name, and a newline.
The source data is © 2024 Unicode, Inc.; see [Unicode.LICENSE](Unicode.LICENSE).

SHA-256:

```text
24f0c534e86cf142e2496953e8f0e46a3e702392911eddcd29c6cced85139697  emoji-test.txt
eb1d44eeec4ca1ee7b88d4fe7fca191fdd783c8809ea8135edb6dcceb704e2ea  emoji.txt
```

Regenerate from the repository root with Python 3's standard library:

```sh
curl -fsS https://unicode.org/Public/emoji/16.0/emoji-test.txt -o /tmp/mayfly-emoji-test.txt
python3 - /tmp/mayfly-emoji-test.txt > srv/static/emoji.txt <<'PY'
import re
import sys
from pathlib import Path

for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    entry = re.fullmatch(r"([0-9A-F ]+)\s*; fully-qualified\s*# (\S+) E\d+\.\d+ (.+)", line)
    if entry and not any(0x1F3FB <= int(n, 16) <= 0x1F3FF for n in entry[1].split()):
        print(entry[2] + "\t" + entry[3])
PY
```

This is a maintenance step; building or running the server never fetches Unicode data.
