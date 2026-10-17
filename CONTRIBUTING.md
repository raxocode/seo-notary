# Contributing

Thanks for your interest in SEO Notary.

## Setup

Requires Node `>=22.19.0`.

```bash
npm install
npm run build && npm run typecheck && npm run lint && npm test && npm run test:security
```

All five commands must pass before a pull request is merged.

## Guidelines

- Keep changes focused; include tests for new behaviour and for failure paths.
- `packages/core` must stay free of browser dependencies.
- Rule IDs are a public contract; do not rename them without a deprecation path.
- Significant design choices are recorded as short notes in [docs/adr](docs/adr/).

## Sign-off and licensing

Contributions are accepted under the project's MIT License. Sign off each commit (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/). This keeps the provenance of contributions clear should the project's licensing structure evolve.

## Security issues

Do not file them as public issues. See [SECURITY.md](SECURITY.md).
