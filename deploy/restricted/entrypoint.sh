#!/bin/sh
set -eu
# State is agent-writable; never resolve privileged bootstrap tools from its PATH.
PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin
export PATH
# Only this container's network namespace is changed. Failure stops startup.
iptables -F OUTPUT
iptables -P OUTPUT DROP
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Do not allow Docker's embedded resolver at 127.0.0.11 through loopback.
iptables -A OUTPUT -o lo -d 127.0.0.1/32 -j ACCEPT
iptables -A OUTPUT -d 172.30.247.2/32 -p tcp --dport 3128 -j ACCEPT
ip6tables -F OUTPUT
ip6tables -P OUTPUT DROP
ip6tables -A OUTPUT -o lo -d ::1/128 -j ACCEPT
for directory in /state/home /state/t3; do
  if [ -L "$directory" ]; then
    echo "Restricted state directories must not be symbolic links." >&2
    exit 1
  fi
done
mkdir -p /state/home /state/t3
chown 1000:1000 /state /state/home /state/t3
exec setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs env PATH=/state/home/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin "$@"
