# Data activity dashboard

Observe a selected agent session before deciding which destinations to block. This is a local companion to the fork, started separately from its web, desktop, or mobile client. It does not modify the running T3 server, system proxy, firewall, or certificate trust store.

From the repository root, install [uv](https://docs.astral.sh/uv/) if needed, then run:

```sh
uv run --locked --project tools/privacy-observer python tools/privacy-observer/observer.py --label codex-test
```

Open the dashboard URL printed by the process. Its fragment contains a session access token; do not share it. The observer binds only to loopback. Keep it running during the test and stop with Ctrl+C afterward. Use different `--proxy-port`, `--dashboard-port`, and `--state-dir` values for simultaneous observers. The default ports are 8899 and 8898.

## Open inside t3ch

The shield icon in the sidebar opens **Privacy dashboard** inside t3ch. It is also available in the command palette and **Settings → General → Diagnostics**. Choose the machine running the observer.

Start the observer on that machine. Set `T3CODE_PRIVACY_OBSERVER_FILE` in the T3 server's launch environment to the absolute `connectionFile` path printed at startup, then restart the T3 server. The file contains the observer's session credential, is created with owner-only permissions, and is refreshed when the observer restarts. Never commit or share it. The server reads it on each request; restarting the observer does not require restarting T3 again.

The dashboard uses T3's authenticated connection, including remote connections. The observer stays on loopback, and its credential never reaches the browser. Diagnostics permission is required to view observations; settings permission is required to block, unblock, or clear them. Without an observer connection, the page shows setup instructions. No traffic is captured until you configure a test session as below.

## Route a test session

Start with synthetic credentials and a disposable project. The observer prints the proxy address and CA certificate path. In the selected provider instance's environment settings, set the following, replacing the CA path with the printed absolute path:

```text
HTTP_PROXY=http://127.0.0.1:8899
HTTPS_PROXY=http://127.0.0.1:8899
NODE_USE_ENV_PROXY=1
NODE_EXTRA_CA_CERTS=/absolute/path/to/.t3-privacy/mitmproxy-ca-cert.pem
SSL_CERT_FILE=/absolute/path/to/.t3-privacy/mitmproxy-ca-cert.pem
REQUESTS_CA_BUNDLE=/absolute/path/to/.t3-privacy/mitmproxy-ca-cert.pem
CURL_CA_BUNDLE=/absolute/path/to/.t3-privacy/mitmproxy-ca-cert.pem
NO_PROXY=localhost,127.0.0.1,::1
```

Restart the selected provider process after changing its environment. To inspect server-owned traffic as well, launch a separate test T3 server with these variables and a separate `T3CODE_HOME`. Do not point the test server at live state. The proxy must run on that server/provider machine; `127.0.0.1` on a remote host is not your desktop.

Client support differs: some CLIs ignore proxy or CA variables, use another trust store, or pin certificates. Do not disable TLS verification to work around that. A TLS error is an inspection failure, not evidence that the request was safe. The dashboard explicitly reports its coverage limits; it cannot count direct requests that bypass the proxy. Browser/mobile clients require their own routing and trust configuration and are not automatically covered by a server-side observer.

The label identifies the process you chose to route; it is not automatic process attribution. Run one provider at a time when identifying traffic ownership. Telemetry/conversation categories are heuristics and do not prove whether the vendor, model, or a plugin authored a request.

## Understand and test

The dashboard shows exact destination hosts, outbound body sizes, recognized payload fields, request outcomes, and sensitive-data pattern findings. It inspects HTTP(S) requests and outbound WebSocket messages. Expected authentication headers are identified separately from possible secrets in bodies, URLs, or other headers. Paths, query values, raw bodies, header values, and matched secrets are not retained or exported. Compressed HTTP bodies are decoded by the proxy before inspection; reported sizes describe the decoded bodies, not network traffic totals. Only the first MiB of a body is scanned, and truncation is visible.

Use **Block** on one exact host, retry the task, inspect failures, and **Unblock** to restore it. Blocking occurs before forwarding the inspected request or WebSocket message; it cannot retract previous requests or stop traffic outside the proxy. Upstream TLS connections may already exist, and rules do not provide OS isolation. No domains start blocked. Rules live only for this observer process. **Clear observations** keeps rules; stopping the observer discards both rules and the in-memory journal. Export saves only the masked metadata currently retained, at most 2,000 events. Destination names can themselves be sensitive; review reports before sharing.

A response confirms that an upstream answered; an error can occur after some data was sent. “No pattern matched” does not mean no sensitive data: proprietary code, arbitrary passwords, encoded content, and unsupported protocols may evade detection. The observer handles decrypted data in memory, and its private CA can impersonate sites to clients that trust it. Keep its state directory private and never commit it. Remove the test proxy/CA settings when finished. Delete that observer's state directory only after stopping it and removing its certificate trust from those clients.

For self-hosted Honcho, traffic to your memory service stays within your infrastructure, but its inference adapter can make a separate provider request. Observe that adapter process separately to see the second hop. This fork's proxy does not automatically observe another machine or container.

## Verification

```sh
uv run --locked --project tools/privacy-observer python -m unittest discover -s tools/privacy-observer -v
```

The tests cover masking, bounded retention, authenticated dashboard access, WebSocket blocks, and a real HTTPS request/block/unblock cycle against a local synthetic service. The HTTPS test requires `openssl` and `curl`; it never installs system certificates or sends fixture data to a public service.
