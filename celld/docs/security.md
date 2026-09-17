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

**Metadata and retention.** Participants see timestamps and source IPs when a
trusted proxy supplies them. The server also sees sizes and traffic patterns.
Deletion does not erase participant copies, backups, or replicated history.

[Security model](security-model.md) explains these boundaries in detail.
