#!/bin/bash
# diagnose-stream.sh - Diagnóstico Completo do Stream Capture

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${NC}"
echo -e "${BLUE}   Stream Capture - Diagnóstico Completo       ${NC}"
echo -e "${BLUE}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${NC}\n"

# 1. VERIFICAR CONTAINER
echo -e "${YELLOW}[1/10] Verificando container...${NC}"
if docker ps | grep -q stream_capture; then
    echo -e "${GREEN}\u2705 Container stream_capture está rodando${NC}"
    CONTAINER_ID=$(docker ps -qf "name=stream_capture")
    echo "   Container ID: $CONTAINER_ID"
else
    echo -e "${RED}\u274c Container stream_capture NÃO está rodando!${NC}"
    echo "   Execute: ./manage.sh start"
    exit 1
fi

# 2. VERIFICAR PORTAS
echo -e "\n${YELLOW}[2/10] Verificando portas...${NC}"
for port in 3001 8080; do
    if nc -z localhost $port 2>/dev/null; then
        echo -e "${GREEN}\u2705 Porta $port está aberta${NC}"
    else
        echo -e "${RED}\u274c Porta $port NÃO está acessível${NC}"
    fi
done

# 3. VERIFICAR API STATUS
echo -e "\n${YELLOW}[3/10] Verificando API status...${NC}"
if curl -s http://localhost:3001/api/status >/dev/null 2>&1; then
    echo -e "${GREEN}\u2705 Web UI API respondendo${NC}"
    curl -s http://localhost:3001/api/status | jq -r '.sessions' 2>/dev/null || echo "   (jq não disponível)"
else
    echo -e "${RED}\u274c Web UI API não responde${NC}"
fi

# 4. VERIFICAR HTTP SERVER STATUS
echo -e "\n${YELLOW}[4/10] Verificando HTTP Stream Server...${NC}"
if curl -s http://localhost:8080/status >/dev/null 2>&1; then
    echo -e "${GREEN}\u2705 HTTP Server respondendo${NC}"
    echo "   Status completo:"
    curl -s http://localhost:8080/status | jq . 2>/dev/null || curl -s http://localhost:8080/status
else
    echo -e "${RED}\u274c HTTP Server não responde na porta 8080${NC}"
fi

# 5. VERIFICAR SESSÕES ATIVAS
echo -e "\n${YELLOW}[5/10] Verificando sessões ativas...${NC}"
SESSIONS=$(curl -s http://localhost:3001/api/sessions 2>/dev/null)
if [ -n "$SESSIONS" ]; then
    echo "$SESSIONS" | jq -r 'to_entries[] | "   Site: \(.key) | Running: \(.value.isRunning) | Status: \(.value.status)"' 2>/dev/null || \
    echo "   (Não foi possível parsear JSON)"
else
    echo -e "${RED}\u274c Nenhuma sessão encontrada${NC}"
fi

# 6. VERIFICAR PIPES CRIADAS
echo -e "\n${YELLOW}[6/10] Verificando pipes criadas...${NC}"
PIPES=$(docker exec stream_capture ls -lh /app/timeshift/*.pipe 2>/dev/null | wc -l)
if [ "$PIPES" -gt 0 ]; then
    echo -e "${GREEN}\u2705 $PIPES pipe(s) encontrada(s):${NC}"
    docker exec stream_capture ls -lh /app/timeshift/*.pipe 2>/dev/null
else
    echo -e "${RED}\u274c Nenhuma pipe encontrada em /app/timeshift/${NC}"
fi

# 7. VERIFICAR PROCESSOS STREAMLINK
echo -e "\n${YELLOW}[7/10] Verificando processos Streamlink...${NC}"
STREAMLINK_PROCS=$(docker exec stream_capture ps aux | grep streamlink | grep -v grep | wc -l)
if [ "$STREAMLINK_PROCS" -gt 0 ]; then
    echo -e "${GREEN}\u2705 $STREAMLINK_PROCS processo(s) Streamlink rodando:${NC}"
    docker exec stream_capture ps aux | grep streamlink | grep -v grep | awk '{print "   PID: " $2 " | CMD: " $11 " " $12 " " $13}'
else
    echo -e "${RED}\u274c Nenhum processo Streamlink rodando${NC}"
fi

# 8. VERIFICAR PIPEREADER NOS LOGS
echo -e "\n${YELLOW}[8/10] Verificando PipeReader nos logs...${NC}"
PIPEREADER_LOGS=$(docker logs stream_capture --tail 50 2>&1 | grep -i "pipereader" | tail -5)
if [ -n "$PIPEREADER_LOGS" ]; then
    echo -e "${GREEN}\u2705 Logs recentes do PipeReader:${NC}"
    echo "$PIPEREADER_LOGS" | while read line; do echo "   $line"; done
else
    echo -e "${YELLOW}\u26a0\ufe0f  Nenhum log recente do PipeReader encontrado${NC}"
fi

# 9. TESTAR LEITURA DE PIPE
echo -e "\n${YELLOW}[9/10] Testando leitura da pipe...${NC}"
PIPE_PATH=$(docker exec stream_capture ls /app/timeshift/*.pipe 2>/dev/null | head -1)
if [ -n "$PIPE_PATH" ]; then
    echo "   Pipe: $PIPE_PATH"
    echo "   Tentando ler dados (timeout 3s)..."
    
    if timeout 3s docker exec stream_capture head -c 1024 "$PIPE_PATH" >/dev/null 2>&1; then
        echo -e "${GREEN}\u2705 Pipe tem dados fluindo!${NC}"
    else
        echo -e "${RED}\u274c Pipe sem dados ou bloqueada${NC}"
    fi
else
    echo -e "${RED}\u274c Nenhuma pipe disponível para testar${NC}"
fi

# 10. VERIFICAR ERROS NOS LOGS
echo -e "\n${YELLOW}[10/10] Procurando erros recentes nos logs...${NC}"
ERRORS=$(docker logs stream_capture --tail 100 2>&1 | grep -i "error\|fail\|exception" | tail -5)
if [ -n "$ERRORS" ]; then
    echo -e "${RED}\u26a0\ufe0f  Erros encontrados:${NC}"
    echo "$ERRORS" | while read line; do echo "   $line"; done
else
    echo -e "${GREEN}\u2705 Nenhum erro crítico encontrado nos últimos 100 logs${NC}"
fi

# RESUMO E RECOMENDAÇÕES
echo -e "\n${BLUE}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${NC}"
echo -e "${BLUE}   RESUMO E RECOMENDAÇÕES                       ${NC}"
echo -e "${BLUE}\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550${NC}\n"

# Verificar problema principal
if [ "$PIPES" -eq 0 ]; then
    echo -e "${RED}\u274c PROBLEMA: Nenhuma pipe foi criada${NC}"
    echo "   Solução:"
    echo "   1. Verificar se captura foi iniciada: curl -X POST http://localhost:3001/api/sessions/start-parallel"
    echo "   2. Ver logs de criação de pipe: docker logs stream_capture | grep 'pipe'"
fi

if [ "$STREAMLINK_PROCS" -eq 0 ]; then
    echo -e "${RED}\u274c PROBLEMA: Streamlink não está rodando${NC}"
    echo "   Solução:"
    echo "   1. Iniciar captura manual: curl -X POST http://localhost:3001/api/sessions/freeshot_dazn/start"
    echo "   2. Verificar configuração do site no config.json"
fi

# Teste final
echo -e "\n${YELLOW}\U0001f9ea TESTE RÁPIDO HTTP:${NC}"
echo "   1. Testar status:"
echo "      curl http://localhost:8080/status | jq ."
echo ""
echo "   2. Testar stream direto:"
echo "      curl -I http://localhost:8080/freeshot_dazn/stream"
echo ""
echo "   3. Abrir no VLC:"
echo "      vlc http://localhost:8080/freeshot_dazn/stream"
echo ""
echo "   4. Ver logs em tempo real:"
echo "      docker logs -f stream_capture"
echo ""

echo -e "${GREEN}\u2705 Diagnóstico concluído!${NC}\n"
