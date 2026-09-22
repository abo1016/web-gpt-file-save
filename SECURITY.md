# Security Policy

## Supported version

Security fixes are applied to the latest code on the `main` branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting / Security Advisory flow for this repository when available. Do not include exploit details, credentials, OAuth tokens, Cloudflare credentials, temporary ChatGPT download URLs, or local filesystem secrets in a public issue.

A useful report includes:

- affected version or commit;
- reproduction steps;
- expected and observed behavior;
- security impact;
- suggested mitigation, if known.

## Security boundaries

This project is designed to:

- write only below the configured `FILE_SAVE_ROOT`;
- reject path traversal and unsafe symlink targets;
- reject private/reserved-network download targets and reduce DNS rebinding risk by pinning validated addresses;
- require OAuth for file writes and local configuration discovery;
- avoid logging temporary ChatGPT download URLs;
- keep local settings and OAuth state out of Git.

Users are responsible for protecting their local machine, Cloudflare account/tunnel credentials, OAuth approval password, and configured save root.
