#!/bin/bash
set -e

echo "🚀 Iniciando Stream Capture Multi-Sessão..."

# Configurar permissões
chown -R appuser:appuser /app/logs /app/timeshift 2>/dev/null || true

# Verificar dependências
echo "🔍 Verificando dependências..."

# Verificar Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não encontrado"
    exit 1
fi

# Verificar Streamlink
if ! command -v streamlink &> /dev/null; then
    echo "❌ Streamlink não encontrado"
    exit 1
fi

# Verificar Google Chrome
if ! command -v google-chrome-stable &> /dev/null; then
    echo "❌ Google Chrome não encontrado"
    exit 1
fi

# Verificar OpenVPN (se VPN habilitada)
if [ "$VPN_ENABLED" = "true" ]; then
    if ! command -v openvpn &> /dev/null; then
        echo "❌ OpenVPN não encontrado (necessário para VPN)"
        exit 1
    fi
    echo "✅ OpenVPN disponível"
fi

# Configurar TUN device para VPN
if [ "$VPN_ENABLED" = "true" ]; then
    echo "🌐 Configurando dispositivo TUN para VPN..."
    mkdir -p /dev/net
    if [ ! -c /dev/net/tun ]; then
        mknod /dev/net/tun c 10 200
        chmod 600 /dev/net/tun
    fi
fi

# Validar configuração
echo "📋 Validando configuração..."
if [ -f "/app/config.json" ]; then
    echo "✅ Arquivo de configuração encontrado"
else
    echo "❌ Arquivo config.json não encontrado"
    exit 1
fi

# Configurar variáveis de ambiente padrão
export NODE_ENV=${NODE_ENV:-production}
export DEBUG=${DEBUG:-false}
export TZ=${TZ:-Europe/Lisbon}

# Configurar timezone
if [ "$TZ" ]; then
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime
    echo $TZ > /etc/timezone
fi

# Criar diretórios necessários
mkdir -p /app/logs /app/timeshift /tmp/vpn

# Aguardar TVHeadend se necessário
if [ "$TVHEADEND_HOST" ]; then
    echo "⏳ Aguardando TVHeadend em $TVHEADEND_HOST:${TVHEADEND_PORT:-9982}..."
    timeout 60 bash -c "
        until nc -z $TVHEADEND_HOST ${TVHEADEND_PORT:-9982}; do
            sleep 2
        done
    " || echo "⚠️ TVHeadend não respondeu (continuando mesmo assim)"
fi

echo "✅ Inicialização concluída"
echo "🎯 Executando: $@"

# Executar comando principal
exec "$@"
```

### 7. nginx/nginx.conf - Load Balancer (Opcional)
```nginx
events {
    worker_connections 1024;
}

http {
    upstream stream_capture {
        server stream-capture:3001;
        # Adicionar mais instâncias se necessário
        # server stream-capture-2:3001;
    }

    upstream stream_api {
        server stream-capture:8080;
        # server stream-capture:8081;
    }

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req_zone $binary_remote_addr zone=streams:10m rate=50r/s;

    # Web UI
    server {
        listen 80;
        server_name localhost;

        # Security headers
        add_header X-Frame-Options DENY;
        add_header X-Content-Type-Options nosniff;
        add_header X-XSS-Protection "1; mode=block";

        # Web UI
        location / {
            proxy_pass http://stream_capture;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            
            # WebSocket support
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }

        # API com rate limiting
        location /api/ {
            limit_req zone=api burst=20 nodelay;
            proxy_pass http://stream_capture;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }

        # Streams com rate limiting específico
        location /streams/ {
            limit_req zone=streams burst=100 nodelay;
            proxy_pass http://stream_api/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            
            # Headers para streaming
            proxy_buffering off;
            proxy_cache off;
            proxy_set_header Connection '';
            proxy_http_version 1.1;
            chunked_transfer_encoding off;
        }
    }
}

