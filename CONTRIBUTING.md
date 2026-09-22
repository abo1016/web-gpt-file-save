# Contributing

Thanks for contributing to web-gpt-file-save.

## Development

Requirements:

- Node.js 20+
- npm

Install dependencies and run the full local test suite:

```bash
npm ci
npm test
```

For public-endpoint tests, configure a Quick or Stable endpoint as described in the README. The public OAuth smoke test additionally requires `P1_AUTH_PASSWORD`.

## Pull requests

- Keep changes focused and include tests for behavior changes.
- Run `npm test` before opening a pull request.
- Do not commit OAuth state, local settings, Cloudflare credentials, generated files, temporary download URLs, or other secrets.
- Keep filesystem writes constrained to the configured `FILE_SAVE_ROOT`.
- Preserve SSRF, DNS rebinding, path traversal, symlink, overwrite, and OAuth protections unless a change deliberately replaces them with an equally strong or stronger design.

## Reporting security issues

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).
