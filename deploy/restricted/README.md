# Restricted provider runner

Run a provider command in a separate Linux container with enforced outbound and filesystem boundaries. This is an opt-in command runner, not a setting applied to existing T3 providers. Existing servers, remote access, and provider processes are unchanged. It includes Node, Python, Git, and curl; it does not install or authenticate any provider CLI.

## Start

Requires Docker Engine (or Docker Desktop's Linux containers), Docker Compose, and Python 3. Use a disposable project copy that contains only files the provider should read. The runner can modify that directory. No host home, SSH directory, Docker socket, or host credentials are mounted.

From the repository root:

```sh
python deploy/restricted/run.py --workspace /absolute/path/to/project -- node --version
```

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

The integration test creates a uniquely named Compose project and synthetic workspace. It proves an allowed HTTPS request succeeds with normal certificate verification; forbidden, private, non-443, and plain-HTTP proxy requests fail; direct IPv4/IPv6 and UDP/TCP DNS attempts fail even without proxy variables; subprocesses cannot bypass the boundary; all provider capabilities are zero; host sentinel files and Docker sockets are absent; and the root filesystem is read-only. It then proves an empty allowlist denies the previously permitted destination. It contacts `example.com` with an empty GET request and removes only its own containers, networks, and test state volume. It does not modify host firewall rules.

This enforces the chosen command's network boundary. It is not a certification that every provider works inside it, or that data sent to permitted services is safe.

The boundary uses [Docker bridge isolation](https://docs.docker.com/engine/network/drivers/bridge/), [Squid destination ACLs](https://www.squid-cache.org/Doc/config/acl/), and [setpriv privilege dropping](https://man7.org/linux/man-pages/man1/setpriv.1.html).
