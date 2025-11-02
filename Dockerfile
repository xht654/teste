# Dockerfile - LINHA 49 MODIFICADA
FROM node:18-slim

# Instalar dependências do sistema incluindo VPN
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libxss1 \
    libgconf-2-4 \
    python3 \
    python3-pip \
    software-properties-common \
    vlc \
    ffmpeg \
    openvpn \
    iptables \
    net-tools \
    iproute2 \
    dnsutils \
    && rm -rf /var/lib/apt/lists/*

# Instalar Google Chrome
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Instalar Streamlink
RUN pip3 install --break-system-packages streamlink

# Criar usuário não-root para segurança
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Definir diretório de trabalho
WORKDIR /app

# Copiar package.json e instalar dependências Node.js
COPY package*.json ./
# MODIFICADO: usar npm install em vez de npm ci
RUN npm install --omit=dev && npm cache clean --force

# Copiar código da aplicação
COPY src/ ./src/
COPY web/ ./web/
COPY index.js ./

# Criar diretórios necessários
RUN mkdir -p /app/logs /app/timeshift /app/vpn /tmp/vpn \
    && chown -R appuser:appuser /app /tmp/vpn

# Definir variáveis de ambiente
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

# Scripts de inicialização
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3001/api/status || exit 1

# Usar usuário não-root (comentado porque VPN precisa de privilégios)
# USER appuser

# Comando para executar a aplicação
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "index.js"]
