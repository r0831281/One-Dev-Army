#!/bin/sh
set -u

root_read_only=true
touch /oda-host-write 2>/dev/null && root_read_only=false

tmp_writable=false
printf '#!/bin/sh\nexit 0\n' > /tmp/oda-probe 2>/dev/null && tmp_writable=true
chmod 0700 /tmp/oda-probe 2>/dev/null || true
tmp_noexec=true
/tmp/oda-probe 2>/dev/null && tmp_noexec=false

host_hidden=true
[ -e /host-sentinel ] && host_hidden=false
docker_hidden=true
[ -S /var/run/docker.sock ] && docker_hidden=false
credentials_hidden=true
env | grep -Eiq '(TOKEN|SECRET|PASSWORD|AUTHORIZATION)=' && credentials_hidden=false
non_root=false
[ "$(id -u)" != "0" ] && non_root=true

network_blocked=true
wget -q -T 1 -O /tmp/network-result http://169.254.169.254/latest/meta-data/ 2>/dev/null && network_blocked=false

memory_limit="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo unavailable)"
pids_limit="$(cat /sys/fs/cgroup/pids.max 2>/dev/null || echo unavailable)"
cpu_limit="$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo unavailable)"

printf '{"rootReadOnly":%s,"tmpWritable":%s,"tmpNoExec":%s,"hostHidden":%s,"dockerHidden":%s,"credentialsHidden":%s,"nonRoot":%s,"networkBlocked":%s,"memoryLimit":"%s","pidsLimit":"%s","cpuLimit":"%s"}\n' \
  "$root_read_only" "$tmp_writable" "$tmp_noexec" "$host_hidden" "$docker_hidden" "$credentials_hidden" "$non_root" "$network_blocked" \
  "$memory_limit" "$pids_limit" "$cpu_limit"
