# Restricted provider runner

Run a provider command in a separate Linux container with enforced outbound and filesystem boundaries. This is an opt-in command runner, not a setting applied to existing T3 providers. Existing servers, remote access, and provider processes are unchanged. It includes Node, Python, Git, and curl; it does not install or authenticate any provider CLI.

## Start

Requires Docker Engine (or Docker Desktop's Linux containers), Docker Compose, and Python 3. Use a disposable project copy that contains only files the provider should read. The runner can modify that directory. No host home, SSH directory, Docker socket, or host credentials are mounted.

From the repository root:

```sh
python deploy/restricted/run.py --workspace /absolute/path/to/project -- node --version
```

To target a specific engine without changing the active Docker context, add
`--docker-context CONTEXT` before `--`. The helper uses that context for preflight,
build, startup, command execution, and cleanup. An unavailable context fails;
there is no retry on another engine. Without the option, existing Docker CLI
context/environment behavior is retained. Keep the selected context's endpoint
stable for the entire run. Bind paths must exist on that engine's host; a remote
context does not upload the workspace or allowlist. Use the same explicit context
for any later volume removal. This option does not certify another runtime's
security semantics. Kiri has not passed this runner's runtime isolation tests;
do not use it as a production replacement on the strength of Docker API support.

The default allowlist is empty: outbound access is denied. To permit a test destination, put `example.com` on a line in a separate allowlist file, then run:

```sh
python deploy/restricted/run.py \
  --workspace /absolute/path/to/project \
  --allowlist /absolute/path/to/allowed-domains.txt \
  -- curl https://example.com
```

Use exact hostnames, one per line. Wildcards, URLs, ports, and leading-dot suffix rules are rejected. The proxy permits HTTPS CONNECT on port 443 only, checks the hostname before DNS resolution, and rejects private, loopback, link-local, multicast, and IPv4-mapped IPv6 destinations. Redirects to additional hosts require explicit entries. TLS verification stays enabled; no inspection CA or system trust changes are involved.

For a provider, build a derivative of `t3-restricted-runner:local` that installs the chosen CLI at a pinned version. Pass that image with `--image your-provider-image:version`, then run the CLI command. Install/authenticate only inside this isolated environment; don't bind the host provider's home or token store. Provider login flows needing callbacks, non-HTTPS protocols, pinned custom transports, or unapproved domains may be unsupported. Test that provider's workflow before using valuable data. This first version has no provider selection, credential broker, or T3 UI integration. No provider-specific compatibility is implied by the generic isolation test.

The image build runs outside the restricted runtime boundary and downloads Debian packages. Review any derivative Dockerfile and its installer; do not supply build secrets or copy your project into the image. Build context for the supplied image includes only the Dockerfile and its two entry scripts.

## Boundary and state

The provider runs as UID1000 with all capability sets empty, no supplementary groups, and `no-new-privileges`. Startup briefly has the capabilities needed to set firewall rules inside its own network namespace, then drops them before running your command. The root filesystem is read-only. A project bind mount, a separate named state volume, and temporary `/tmp` are writable. The project directory must be writable by UID1000; the runner does not recursively change host ownership.

The runner's internal Docker network has no Internet route. Container firewall rules additionally allow only the egress proxy's address/port and local loopback. Removing proxy variables, invoking a subprocess, using raw TCP, or querying Docker's embedded DNS does not grant outbound access. Firewall/bootstrap failure stops the command rather than running without restrictions. The proxy has a separate Internet-connected network; its port is not published to the host. No application ports are published, so this runner does not expose an unauthenticated T3 server.

The fixed private subnet `172.30.247.0/24` must be unused. A collision stops startup. One session can use it at a time; the helper removes its own containers/networks when the command exits and preserves its state volume. Do not run simultaneous helpers with the same state name. Use `--name example` to select a stable state name; without it, the name is derived from the absolute project path. The resulting volume is `t3-restricted-example_state`. To erase that isolated state, first stop that runner, then explicitly remove that named volume. The helper never deletes state automatically.

Credentials provisioned inside the runner are still readable by that provider and its subprocesses. An approved destination can receive any data the provider can read. Rules constrain the CONNECT destination, not decrypted HTTP Host headers or application identity behind a shared endpoint; domain fronting and approved services that themselves forward traffic remain possible. This boundary does not perform content redaction, prevent malicious output from being written into the selected project, protect against kernel/Docker exploits, or establish third-party extension provenance. Docker administrators and the host user remain trusted. The production observer is separate: this proxy enforces destinations without decrypting HTTPS, and its traffic does not automatically appear in the privacy dashboard.

## Verify

```sh
python -m unittest discover -s deploy/restricted -p 'test_restricted.py' -v
```

To run the same proof on an explicitly selected Docker context:

```sh
T3_RESTRICTED_DOCKER_CONTEXT=default python -m unittest discover -s deploy/restricted -p 'test_restricted.py' -v
python -m unittest discover -s deploy/restricted -p 'test_run.py' -v
```

The integration test creates a uniquely named Compose project and synthetic workspace. It proves an allowed HTTPS request succeeds with normal certificate verification; forbidden, private, non-443, and plain-HTTP proxy requests fail; direct IPv4/IPv6 and UDP/TCP DNS attempts fail even without proxy variables; subprocesses cannot bypass the boundary; all provider capabilities are zero; host sentinel files and Docker sockets are absent; and the root filesystem is read-only. It then proves an empty allowlist denies the previously permitted destination. It contacts `example.com` with an empty GET request and removes only its own containers, networks, and test state volume. It does not modify host firewall rules.

This enforces the chosen command's network boundary. It is not a certification that every provider works inside it, or that data sent to permitted services is safe.

The boundary uses [Docker bridge isolation](https://docs.docker.com/engine/network/drivers/bridge/), [Squid destination ACLs](https://www.squid-cache.org/Doc/config/acl/), and [setpriv privilege dropping](https://man7.org/linux/man-pages/man1/setpriv.1.html).

## Experimental Codex binaryPath launch option

`codex.py` is an opt-in Linux/local-Docker transport for **one disposable workspace per Codex provider instance**. Defaults and other providers are unchanged. It runs Codex 0.171.0 with stdio preserved, no TTY, no host CLI fallback, and isolated `CODEX_HOME=/state/codex`. Host-side T3 Git, checkpoints, MCP and other T3 tools remain outside this boundary. This is provider-process isolation, not whole-T3 isolation. Paid-provider compatibility is not certified.

Build explicitly (build network access is outside the workload boundary):

```sh
docker --context default build -f deploy/restricted/Dockerfile.codex -t t3-restricted-codex:0.171.0 deploy/restricted
docker --context default image inspect t3-restricted-codex:0.171.0 --format '{{.Id}}'
```

Create an operator-owned JSON file outside the selected workspace, replacing the image with the returned immutable `sha256:...` ID:

```json
{
  "workspace": "/home/operator/disposable/project",
  "context": "default",
  "image": "sha256:REPLACE_WITH_IMAGE_ID",
  "allowlist": "/home/operator/restricted-hosts.txt",
  "state": "experiment-one"
}
```

The allowlist must contain explicitly selected exact hostnames, one per line; an empty file denies all external traffic. There is no implicit provider allowlist, TLS interception, token copying or credential-broker integration. The CLI, proxy and read-only system image share the selected image identity. Each invocation snapshots the allowlist. Normal TLS verification and the existing CONNECT-only/private-address denial apply.

Create an executable launcher outside the workspace:

```sh
#!/bin/sh
exec /absolute/checkout/deploy/restricted/codex.py --config /absolute/operator-config.json "$@"
```

Set the existing Codex provider instance `binaryPath` to that launcher. Leave custom homePath/launchArgs unset initially. All launches through this binaryPath—including version, account/auth, models, skills and app-server—use the container. Probes may start concurrently, so every invocation has its own Docker project and randomly selected private /24 subnet. A collision fails closed; there is no retry on another engine or host CLI. Cold launches include proxy health checks: increase the provider probe timeout if necessary. Operator-provided launch flags are passed to the isolated CLI, not interpreted as engine commands.

The workspace is mounted at its matching absolute path; protocol prompt content is never rewritten. Canonical absolute workspace paths are required. Existing escaping symlinks, hardlinked files and nested mounts are rejected. Do not modify host mount topology or replace the workspace during a session. Workspace `cwd` requests must stay within the bound workspace; an incompatible request ends the process with an error on stderr. Resume by filesystem path is unsupported. One instance cannot serve other projects or external worktrees; configure separate instances/launchers. Host-configured MCP commands, files outside the workspace, host skills/plugins, host executables and local host services are unavailable inside the container. Provider-managed worktrees outside this mount are unsupported.

State volume name is `t3-codex-<identity digest>` (visible in Compose stderr). Identity includes workspace path/device/inode, Docker context/endpoint, immutable image, operator state name and allowlist contents. Reconnect with the same identity reuses state; changing any of those starts separate state. Authentication can be provisioned manually by running the launcher with Codex's supported login options; it stays in the named volume. Never copy host auth files or tokens. Login/browser/device workflows and real authenticated turns remain unverified. Restoring the former binaryPath and restarting that provider reverts the option. Once all its processes stop, explicitly remove the named volume to erase isolated state; normal cleanup preserves it.

Build/up/cleanup diagnostics go to stderr; only Codex stdout reaches T3. A separate cleanup guardian removes the invocation's containers/networks on EOF, cancellation or wrapper death, including T3's force-kill path. Host/daemon failure can still leave resources: inspect the `t3-codex-*` project named in stderr and remove that exact project. No daemon-wide cleanup is appropriate. State volumes intentionally survive. Run `TMPDIR=/your/scratch python3 -m unittest test_codex` from this directory after building the pinned image for explicit Docker integration tests; this is not part of the default provider launch.
