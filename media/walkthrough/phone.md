# Your sessions on the phone

*omp: Connect Phone…* pairs the **Orchestrator** mobile app ([App Store](https://apps.apple.com/app/ao-mobile/id6792552173), [Google Play](https://play.google.com/store/apps/details?id=aoagents.dev)) with this machine: scan the QR code and the app lists your sessions, follows them live, answers approvals and questions, and sends prompts.

- **Local network and Tailscale**: the phone reaches AO on the same Wi-Fi, or anywhere over Tailscale (with TLS where Tailscale has certificates).
- **Anywhere**: adds a Cloudflare tunnel, encrypted and reachable from any network.

The code carries this machine's AO password. *Rotate Remote Access Token* unpairs every phone; *Disable Remote Access* turns it off.
