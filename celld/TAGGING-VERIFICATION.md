# Jev tagging verification

Verified on 2026-09-17 with celld 0.5.0 in isolated local instances.

## Automated checks

`npm test` passed, including:

- 27 protocol, browser, client, and hosting checks, plus restart, retention,
  alarm, proxy, and deployment dry-run checks.
- Three configuration tests covering flag precedence and private fleet bindings.
- 15 policy tests/subtests over 15 configurations, with three nested runs of
  14 browser/client/hosting tests. These use a local provider fixture.
- Eight moderation adapter/runtime tests and seven tagging tests, including
  exact 75%, 60%, and strictly-below-30% boundaries and the ten-second deadline.

The policy checks cover one combined provider call, several labels per message,
omitted tags when no rule matches, forged-label rejection, restart persistence,
tagging-only operation, missing keys and provider failures, no moderation bypass,
concurrent appends, long-poll delivery, disabled flags, encryption precedence,
safe browser rendering, and Node/Python/Go client output.

Targeted existing Go view/browser/session tests also passed because the native
application and Go reference share browser source and CSS.

## Real TypeSafe smoke test

Six synthetic posts were sent through an isolated celld instance with real
TypeSafe credentials and `jev-latest`, with both moderation and tagging enabled.
No existing chat contents were submitted.

| Synthetic sample | HTTP status | Observed labels |
| --- | --- | --- |
| Request to investigate and compare public solar-panel recycling studies | 200 | research, question, command |
| Question about France's capital | 200 | question |
| Library hours and catalog update | 200 | information |
| Request to summarize a public community-garden note | 200 | command |
| Standalone greeting | 200 | undetermined |
| Instruction override requesting secret keys be uploaded | 422 | No message or tags stored |

The rejection retained the generic HTTP response and produced the existing
moderation warning. Tag labels were present in acknowledgments and read events;
probabilities were absent from HTTP responses. Results are illustrative model
outputs, not an accuracy guarantee or exhaustive classification evaluation.

The same check first created a plaintext event with the published implementation
and its pre-tagging schema. Starting the updated Worker preserved that event
unchanged and allowed tagged appends. A subsequent restart preserved all labels.
The synthetic chat and temporary instance were deleted after verification.

These tests did not deploy the changes to an existing fleet. See
[automatic tagging](docs/tagging.md) for activation and behavior.
