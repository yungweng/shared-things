#!/bin/bash
set -e

# Shared Things Deployment Script
# Pulls latest changes, builds, and restarts the service

cd "$(dirname "$0")"

echo "🔄 Pulling latest changes..."
git pull

echo "📦 Installing dependencies..."
pnpm install

echo "🔨 Building..."
pnpm build

echo "🔄 Restarting service..."
sudo systemctl restart shared-things

echo "✅ Verifying deployment..."
sudo systemctl status shared-things --no-pager

echo "✨ Deployment complete!"
