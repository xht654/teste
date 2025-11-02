#!/bin/bash

# Script para debug do streaming com pipe

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

echo ""
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo -e "${BLUE}   Stream Capture - Debug Pipe         ${NC}"
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo ""

# 1. Verificar se container está rodando
print_info "Verificando container stream_capture..."
if ! docker ps | grep -q stream_capture; then
    print_error "Container não está rodando!"
    echo "Execute: ./manage.sh start"
    exit 1
fi
print_success "Container rodando"

# 2. Verificar pipes existentes
print_info "Verificando pipes em /app/timeshift/..."
PIPES=$(docker exec stream_capture ls -lh /app/timeshift/*.pipe 2>/dev/null | wc -l)
if [ "$PIPES" -gt 0 ]; then
    print_success "Encontradas $PIPES pipe(s):"
    docker exec stream_capture ls -lh /app/timeshift/*.pipe
else
    print_warning "Nenhuma pipe encontrada"
fi

echo ""

# 3. Verificar processos
print_info "Verificando processos no container..."
echo ""
echo "Streamlink:"
docker exec stream_capture ps aux | grep streamlink | grep -v grep || echo "  Nenhum processo"
echo ""
echo "FFmpeg:"
docker exec stream_capture ps aux | grep ffmpeg | grep -v grep || echo "  Nenhum processo"

echo ""

# 4. Testar leitura da pipe
print_info "Testando se pipe tem dados..."
PIPE_PATH=$(docker exec stream_capture ls /app/timeshift/*.pipe 2>/dev/null | head -1)

if [ -n "$PIPE_PATH" ]; then
    print_info "Pipe encontrada: $PIPE_PATH"
    
    # Tentar ler 1 segundo da pipe
    print_info "Tentando ler da pipe (timeout 5s)..."
    if timeout 5s docker exec stream_capture head -c 1024 "$PIPE_PATH" > /dev/null 2>&1; then
        print_success "Pipe tem dados! ✨"
    else
        print_error "Pipe não tem dados ou timeout"
    fi
else
    print_error "Nenhuma pipe encontrada para testar"
fi

echo ""

# 5. Logs recentes
print_info "Últimos 20 logs do stream_capture:"
docker logs --tail 20 stream_capture

echo ""

# 6. Testar com VLC (se disponível)
print_info "Como testar com VLC:"
echo ""
echo "  1. Via HTTP (recomendado):"
echo "     vlc http://localhost:8080/freeshot_dazn/stream.m3u8"
echo ""
echo "  2. Via TVHeadend:"
echo "     - Abrir http://localhost:9981"
echo "     - Configuration > DVB Inputs > Networks"
echo "     - Verificar se 'Stream_teste' existe"
echo ""

# 7. Menu de ações
echo ""
echo -e "${YELLOW}═══════════════════════════════════════${NC}"
echo "Ações disponíveis:"
echo ""
echo "  1) Ver logs contínuos"
echo "  2) Testar stream com curl"
echo "  3) Reiniciar sessão"
echo "  4) Entrar no container"
echo "  0) Sair"
echo ""
read -p "Escolha uma opção: " -n 1 -r option
echo ""

case $option in
    1)
        print_info "Exibindo logs (Ctrl+C para sair)..."
        docker logs -f stream_capture
        ;;
    2)
        print_info "Testando HTTP stream..."
        curl -I http://localhost:8080/freeshot_dazn/stream.m3u8
        ;;
    3)
        print_info "Reiniciando sessão..."
        curl -X POST http://localhost:3000/api/sessions/restart/freeshot_dazn
        echo ""
        print_success "Sessão reiniciada"
        ;;
    4)
        print_info "Entrando no container..."
        docker exec -it stream_capture /bin/bash
        ;;
    0)
        print_info "Saindo..."
        ;;
    *)
        print_error "Opção inválida"
        ;;
esac

echo ""
