"""Generate exact-host rules without accepting Squid configuration in the allowlist."""
import os
from pathlib import Path
import re

names = []
for line in Path('/etc/squid/allowed-domains.txt').read_text().splitlines():
    name = line.split('#', 1)[0].strip().lower()
    if not name:
        continue
    if len(name) > 253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*', name):
        raise SystemExit('Allowlist entries must be exact hostnames, without wildcards, ports, or URLs.')
    names.append(name)
config = '''http_port 3128
pid_filename /tmp/squid.pid
cache_log /dev/stderr
access_log none
cache_store_log none
cache deny all
coredump_dir /tmp
visible_hostname restricted-egress
acl tls_port port 443
acl connect_method method CONNECT
acl private_dst dst 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4 ::/128 ::1/128 ::ffff:0:0/96 fc00::/7 fe80::/10 ff00::/8
http_access deny !connect_method
http_access deny !tls_port
'''
if names:
    config += 'acl permitted dstdomain -n ' + ' '.join(sorted(set(names))) + '\n'
    # Reject unapproved names before resolution, limiting DNS queries to approved names.
    config += 'http_access deny !permitted\nhttp_access deny private_dst\nhttp_access allow permitted\n'
config += 'http_access deny all\n'
Path('/tmp/squid.conf').write_text(config)
os.execvp('squid', ['squid', '-N', '-f', '/tmp/squid.conf'])
