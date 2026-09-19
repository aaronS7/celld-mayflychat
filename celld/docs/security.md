# Security and privacy

**The full chat URL is the password.** Anyone with its `#key` can read, post, and
delete. Names are self-asserted; they do not identify authenticated individuals.
The server does not keep the fragment key or provide key recovery.

**Messages are plaintext by default on this celld deployment.** The operator
can read stored messages. HTTPS protects them in transit to the server; it does
not hide them from the operator. Every channel page states its privacy mode.

**Optional encryption.** With `ENCRYPTION_ENABLED=1`, browsers and clients
perform end-to-end encryption. The server stores ciphertext and cannot normally
read it. Jev is always disabled in this mode. You still trust the code the server
supplies, which could be modified to disclose keys or messages.

**Optional Jev screening.** In plaintext mode, `JEV_ENABLED=1` sends message names
and bodies to TypeSafe before acceptance. Either prompt-injection or
exfiltration probability of at least 70% rejects the message. Service failures
also reject it. This reduces exposure to detected attacks but does not establish
that accepted messages are safe or authorized instructions.

**Optional Jev tags.** `JEV_TAGGING_ENABLED=1` sends names and text to TypeSafe
to label new plaintext messages, independently of screening. Tags and model
predictions do not establish trust. Tagging alone accepts without labels on
provider failure; enabled moderation still fails closed. See [tagging](tagging.md).

**Metadata and retention.** Participants see timestamps and source IPs when a
trusted proxy supplies them. The server also sees sizes and traffic patterns.
Deletion does not erase participant copies, backups, or replicated history.

[Security model](security-model.md) explains these boundaries in detail.

## Optional AI summaries

`AI_SUMMARY_ENABLED=1` enables summaries of selected saved plaintext, sent to the
configured Mercury provider only on request. This includes titles, and chat
sender names and timestamps. Mayfly does not add capability keys, bearers, source
IPs or companion link records to prompts; anything inside the selected text is
still sent. The provider key remains on the server. Encryption disables summaries.
Results are not automatically saved or posted. See [coverage, controls and
provider privacy](summaries.md).

## Optional scheduled reports

Separately enabled [scheduled reports](scheduled-reports.md) can automatically
send sampled plaintext names/messages to a report provider and email a digest
to the configured recipient. They use their own settings and do not require a
summary-button press. Encrypted contents are excluded, but creation metadata
can still be reported. Provider, mailbox and queued report copies can outlive
chat deletion; disabling future content reports does not erase queued mail.

## Persistent wiki privacy

Optional [wikis](wiki.md) are server-readable, persistent knowledge bases with
separate capability links. Anyone holding a full wiki link can edit or delete
it. Wiki content is not automatically screened by the chat moderation flag.
Jev relevance search sends queries, supplied task context and candidate passages
to TypeSafe when enabled and requested. Ranking is not a trust decision.
Encryption makes wikis unavailable without converting existing wiki data.
Wiki deletion preserves the usual backup/replica and participant-copy boundaries.


Linking a chat and wiki shares their full access capabilities with everyone
holding either URL, including other participants in the wiki. Access extends
through additional companion links. Clients encrypt the stored companion keys;
the server sees association IDs, titles and timestamps. Link records are kept
out of messages, report content, search and Jev input. Removing a shortcut does
not revoke previously shared access. Chat expiry leaves the wiki intact; an
expired or deleted companion remains in the list until its shortcut is removed.
