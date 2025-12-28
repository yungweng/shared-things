# Server Deployment (Hetzner)

Guide for deploying the shared-things server on a Hetzner VPS.

## Prerequisites

- Hetzner VPS (CX11 is sufficient: 1 vCPU, 2GB RAM)
- Domain pointing to your VPS (e.g., `things.example.com`)
- SSH access

## 1. Server Setup

SSH into your server:

```bash
ssh root@your-server-ip
```

### Install Node.js 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version  # Should be 20.x
```

### Install pnpm

```bash
npm install -g pnpm
```

### Install Caddy (Reverse Proxy + Auto HTTPS)

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install caddy
```

## 2. Deploy Application

### Create app user

```bash
useradd -m -s /bin/bash sharedthings
```

### Clone and build

```bash
su - sharedthings
git clone https://github.com/YOUR_USERNAME/shared-things.git
cd shared-things
pnpm install
pnpm build
```

### Create users

```bash
cd ~/shared-things
pnpm --filter server run create-user --name "yonnock"
# Save the API key!

pnpm --filter server run create-user --name "florian"
# Save the API key!
```

## 3. Configure Caddy

Edit `/etc/caddy/Caddyfile`:

```caddyfile
things.example.com {
    reverse_proxy localhost:3000
}
```

Reload Caddy:

```bash
systemctl reload caddy
```

Caddy automatically obtains and renews Let's Encrypt certificates.

## 4. Create systemd Service

Create `/etc/systemd/system/shared-things.service`:

```ini
[Unit]
Description=shared-things server
After=network.target

[Service]
Type=simple
User=sharedthings
WorkingDirectory=/home/sharedthings/shared-things
ExecStart=/usr/bin/node packages/server/dist/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable shared-things
systemctl start shared-things
```

## 5. Verify

Check status:

```bash
systemctl status shared-things
```

Test health endpoint:

```bash
curl https://things.example.com/health
# Should return: {"status":"ok","timestamp":"..."}
```

## Maintenance

### View logs

```bash
journalctl -u shared-things -f
```

### Restart server

```bash
systemctl restart shared-things
```

### Update application

```bash
su - sharedthings
cd shared-things
git pull
pnpm install
pnpm build
exit
systemctl restart shared-things
```

### Backup database

The SQLite database is at `~sharedthings/.shared-things-server/data.db`:

```bash
cp /home/sharedthings/.shared-things-server/data.db /backup/data-$(date +%Y%m%d).db
```

## Firewall

If using ufw:

```bash
ufw allow 22    # SSH
ufw allow 80    # HTTP (Caddy redirect)
ufw allow 443   # HTTPS
ufw enable
```

## Troubleshooting

### Server won't start

Check logs:

```bash
journalctl -u shared-things -n 50
```

### Permission denied

Ensure the sharedthings user owns the data directory:

```bash
chown -R sharedthings:sharedthings /home/sharedthings/.shared-things-server
```

### Caddy certificate issues

Check Caddy logs:

```bash
journalctl -u caddy -f
```

Ensure your domain's DNS A record points to your server IP.
