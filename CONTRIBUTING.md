# Contributing

Mayfly is **fork first** software. Please fork it and change it to suit your needs. Only send changes upstream if they are important and you have personally used them for a while. Pull requests will generally be reviewed very slowly.

Security fixes are the exception. However, they must:

- Address a finding that survives the [vulnerability brocards](https://vulnbrocards.com/) test.
- Be a small, focused, minimal change.
- Be validated against the affected runtime's security model:
  [native celld](celld/docs/security-model.md) or [original Go](srv/docs/security-model.md).

Security fixes that fail any of these tests will be closed without substantial discussion. Sorry. Life is too short.

For the code layout, build commands, and tests, see [ARCHITECTURE.md](ARCHITECTURE.md), the technical reference written for and by agents.

Native configuration changes must also keep the
[environment-variable reference](celld/docs/configuration.md) consistent with
the implementation and regenerate the served docs with `npm run generate`.

The GitHub Pages documentation lives in [`website/`](website/README.md). Its
reference pages are generated from the application docs. Run `npm ci` and
`npm run build` inside `website/` to check documentation changes.
