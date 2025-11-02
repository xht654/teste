# Stream Capture Multi-Sessão v2.0

Sistema avançado de captura de streams com suporte a VPN, sessões paralelas e integração TVHeadend.

## 🚀 Características

- **🌐 Captura Paralela**: Execute N sites simultaneamente
- **🔐 VPN Integrada**: Suporte nativo para PureVPN e OpenVPN
- **🎯 Detecção Inteligente**: Padrões universais e específicos por site
- **📱 Interface Moderna**: Web UI responsiva com controle total
- **🔧 Streamlink Avançado**: Suporte a referer e parâmetros personalizados
- **📊 Monitoramento**: Dashboard em tempo real com métricas
- **🛡️ Proteção Anti-Ads**: Múltiplos níveis configuráveis
- **💾 Backup Automático**: Sistema completo de backup/restore

## 📋 Pré-requisitos

- Docker & Docker Compose
- 4GB+ RAM recomendado
- Credenciais PureVPN (opcional)

## ⚡ Instalação Rápida

```bash
# 1. Clonar repositório
git clone <repository-url>
cd stream-capture-project

# 2. Configuração inicial
./manage.sh setup

# 3. Editar configurações
nano .env
nano config.json

# 4. Iniciar sistema
./manage.sh start

# 5. Acessar interface
# Web UI: http://localhost:3001
# TVHeadend: http://localhost:9981
```

## 🔧 Configuração

### Variáveis de Ambiente (.env)
```bash
# Criptografia
ENCRYPTION_KEY=sua-chave-secreta-aqui

# VPN (PureVPN)
VPN_ENABLED=true
VPN_USERNAME=seu-usuario-purevpn
VPN_PASSWORD=sua-senha-purevpn

# TVHeadend
TVHEADEND_USER=admin
TVHEADEND_PASS=admin
```

### Sites (config.json)
```json
{
  "sites": {
    "meu_site": {
      "name": "Meu Site",
      "url": "https://exemplo.com/stream",
      "enabled": true,
      "captureMethod": "simple",
      "referer": "https://exemplo.com/",
      "vpnRequired": false
    }
  }
}

