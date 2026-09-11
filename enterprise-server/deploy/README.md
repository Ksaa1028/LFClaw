# systemd deployment

Create a dedicated `lfclaw` user with access to `/opt/LfClaw/data`,
`/opt/LfClaw/storage`, and `/opt/LfClaw/releases`. Then install the unit and
environment file:

```bash
sudo cp lfclaw-enterprise.service /etc/systemd/system/
sudo cp lfclaw-enterprise.env.example /etc/lfclaw-enterprise.env
sudo chmod 600 /etc/lfclaw-enterprise.env
sudo systemctl daemon-reload
sudo systemctl enable --now lfclaw-enterprise
```

Verify the service and view retained journal logs:

```bash
curl --fail http://127.0.0.1:8787/healthz
sudo systemctl status lfclaw-enterprise
sudo journalctl -u lfclaw-enterprise -f
```

Configure journald retention in `/etc/systemd/journald.conf`; for a one-time
cleanup, use `sudo journalctl --vacuum-time=14d`.
