# MyDataBkt

**Your data, your machine, consent-gated read and write.**

MyDataBkt is a personal data bucket agent that runs on your Mac. It indexes a folder you choose, connects to the Openly Trusted Network relay, and serves your files to AI agents — but only when you approve through the Green Shield consent gate.

Every read and every write passes through the [Human Consent Layer](https://github.com/mikeoz/human-consent-layer). The AI never touches your files without your explicit consent. The consent is recorded in a tamper-evident hash chain. You can revoke at any time.

## What It Does

- Indexes a folder on your Mac into a recursive manifest (filename, size, type).
- Connects outbound to the OTN relay via WebSocket.
- Serves files when the relay routes an authorized, consent-proven read request.
- Writes files when the relay routes an authorized, consent-proven write request.
- Extracts text from PDFs locally before sending, so the AI receives readable text.
- Validates consent proofs (EdDSA JWT) — checks scope, checks revocation, denies if invalid.
- Prevents path traversal — files outside your designated folder are never accessible.
- Re-indexes automatically when files change (filesystem watcher).

## How It Works With the HCL

1. You chat with an AI on opn.li. The AI needs to read a file from your bucket.
2. The AI calls `bucket_read`. The Green Shield fires. You see what the AI wants and why.
3. You click Allow. A consent proof (EdDSA JWT with read scope) is minted.
4. The request routes through the relay to MyDataBkt on your Mac.
5. MyDataBkt validates the proof, checks scope and revocation, and serves the file.
6. The decision is recorded in the hash chain with a receipt.

The same flow works for writes (Helpful mode saves chat transcripts to your bucket).

## Installation

MyDataBkt is distributed as a signed, notarized macOS application (.dmg). See [Releases](https://github.com/mikeoz/mydatabkt/releases) for the latest version.

## Development

```bash
node agent.cjs --folder ~/Desktop/MyRecords --relay wss://otn-relay.fly.dev
```

Requires Node.js 18+. The `ws` package is the only runtime dependency.

## Related

- [Human Consent Layer](https://github.com/mikeoz/human-consent-layer) — The HCL specification and CARD schemas.
- [HCL DevKit](https://github.com/mikeoz/hcl-devkit) — Developer tools for HCL integration.
- [CROCbox](https://github.com/mikeoz/crocbox) — HCL reference implementation for OpenClaw agents.
- [opn.li](https://opn.li) — The Openly Trusted Network.

## License

Apache 2.0 — Opnli Corporation
