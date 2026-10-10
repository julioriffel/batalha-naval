#!/bin/bash
set -e

echo "🚀 Atualizando Batalha Naval para produção..."
git pull origin main
docker compose up -d --build --force-recreate
echo "✅ Deploy concluído com sucesso!"
docker ps --filter "name=batalha-naval"
