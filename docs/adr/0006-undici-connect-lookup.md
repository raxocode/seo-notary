# ADR 0006: undici connect-time IP validation

Status: accepted (2026-10-17)

Experiment with undici 8.12.2 on Node 22.22.2: `new Agent({ connect: { lookup } })` calls `lookup(hostname, options, callback)` with `options = { hints: 32, all: true }`. Answering with the array form `callback(null, [{ address, family }])` is accepted and the socket connects to the returned address (a made-up hostname connected to 127.0.0.1).

Consequences:
- The lookup callback must support both `all: true` (array) and `all: false` (address, family) forms.
- The validated answer is the connect target, so no second resolution can differ (pinning).
- IP-literal hosts may not go through `lookup`; they are validated before the request by the same policy function.
- Policy failures in `lookup` surface as wrapped request errors; the fetcher walks the `cause` chain to recover the typed error.
