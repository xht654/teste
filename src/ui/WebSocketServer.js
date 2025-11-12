/ src/ui/WebSocketServer.js - Sistema de Notificações em Tempo Real
import { WebSocketServer } from 'ws';
import Logger from '../utils/Logger.js';

export default class WSNotificationServer {
  constructor(webServer, sessionManager) {
    this.webServer = webServer;
    this.sessionManager = sessionManager;
    this.logger = new Logger('WebSocket');
    this.wss = null;
    this.clients = new Set();
  }

  start() {
    try {
      // Criar WebSocket Server na mesma porta do HTTP (3001)
      this.wss = new WebSocketServer({ 
        server: this.webServer.server,
        path: '/ws'
      });

      this.setupWebSocketHandlers();
      this.setupSessionListeners();

      this.logger.info('🔌 WebSocket Server ativo em ws://localhost:3001/ws');
      return true;
    } catch (error) {
      this.logger.error('❌ Erro ao iniciar WebSocket:', error);
      return false;
    }
  }

  setupWebSocketHandlers() {
    this.wss.on('connection', (ws, req) => {
      const clientIp = req.socket.remoteAddress;
      this.logger.info(`🔌 Cliente conectado: ${clientIp}`);
      
      this.clients.add(ws);

      // Enviar estado inicial
      this.sendInitialState(ws);

      // Heartbeat
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      // Mensagens do cliente
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          this.handleClientMessage(ws, message);
        } catch (error) {
          this.logger.error('Erro ao processar mensagem:', error);
        }
      });

      // Desconexão
      ws.on('close', () => {
        this.logger.debug(`🔌 Cliente desconectado: ${clientIp}`);
        this.clients.delete(ws);
      });

      ws.on('error', (error) => {
        this.logger.error('WebSocket error:', error);
        this.clients.delete(ws);
      });
    });

    // Heartbeat interval (30s)
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          this.clients.delete(ws);
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    this.logger.info('✅ WebSocket handlers configurados');
  }

  setupSessionListeners() {
    // ==========================================
    // CRÍTICO: Escutar eventos do SessionManager
    // ==========================================

    // Stream encontrado
    this.sessionManager.on('streamFound', (data) => {
      this.logger.debug(`📡 Stream encontrado: ${data.siteId}`);
      this.broadcast({
        type: 'stream_found',
        siteId: data.siteId,
        data: data,
        timestamp: new Date().toISOString()
      });
    });

    // Sessão iniciada
    this.sessionManager.on('sessionStarted', (data) => {
      this.logger.debug(`▶️ Sessão iniciada: ${data.siteId}`);
      this.broadcast({
        type: 'session_started',
        siteId: data.siteId,
        data: data,
        timestamp: new Date().toISOString()
      });
    });

    // Sessão parada
    this.sessionManager.on('sessionEnded', (data) => {
      this.logger.debug(`⏹️ Sessão parada: ${data.sessionId}`);
      this.broadcast({
        type: 'session_ended',
        data: data,
        timestamp: new Date().toISOString()
      });
    });

    // ✅ NOVO: Sessão reiniciada
    this.sessionManager.on('sessionRestarted', (data) => {
      this.logger.debug(`🔄 Sessão reiniciada: ${data.siteId}`);
      this.broadcast({
        type: 'session_restarted',
        siteId: data.siteId,
        restartCount: data.restartCount,
        data: data,
        timestamp: new Date().toISOString()
      });
    });

    // Erro em sessão
    this.sessionManager.on('sessionError', (data) => {
      this.logger.debug(`❌ Erro em sessão: ${data.siteId}`);
      this.broadcast({
        type: 'session_error',
        siteId: data.siteId,
        error: data.error,
        timestamp: new Date().toISOString()
      });
    });

    // ✅ NOVO: Atualização de status
    this.sessionManager.on('statusUpdate', (data) => {
      this.broadcast({
        type: 'status_update',
        siteId: data.siteId,
        status: data.status,
        data: data,
        timestamp: new Date().toISOString()
      });
    });

    this.logger.info('✅ Session listeners configurados');
  }

  sendInitialState(ws) {
    try {
      const sessions = this.sessionManager.getSessionsStatus();
      
      ws.send(JSON.stringify({
        type: 'initial_state',
        sessions: sessions,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      this.logger.error('Erro ao enviar estado inicial:', error);
    }
  }

  handleClientMessage(ws, message) {
    switch (message.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'subscribe':
        // Cliente pode solicitar subscrição específica
        this.sendInitialState(ws);
        break;

      case 'request_update':
        // Cliente solicita atualização manual
        const sessions = this.sessionManager.getSessionsStatus();
        ws.send(JSON.stringify({
          type: 'sessions_update',
          sessions: sessions,
          timestamp: new Date().toISOString()
        }));
        break;

      default:
        this.logger.debug(`Mensagem desconhecida: ${message.type}`);
    }
  }

  broadcast(data) {
    const message = JSON.stringify(data);
    let sent = 0;

    this.clients.forEach((client) => {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(message);
          sent++;
        } catch (error) {
          this.logger.error('Erro ao enviar para cliente:', error);
          this.clients.delete(client);
        }
      }
    });

    if (sent > 0) {
      this.logger.debug(`📤 Broadcast enviado para ${sent} cliente(s): ${data.type}`);
    }
  }

  // Enviar atualização periódica de todas as sessões
  startPeriodicUpdates(intervalMs = 5000) {
    this.updateInterval = setInterval(() => {
      if (this.clients.size > 0) {
        const sessions = this.sessionManager.getSessionsStatus();
        this.broadcast({
          type: 'sessions_update',
          sessions: sessions,
          timestamp: new Date().toISOString()
        });
      }
    }, intervalMs);

    this.logger.info(`⏰ Atualizações periódicas iniciadas (${intervalMs}ms)`);
  }

  stop() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    if (this.wss) {
      this.wss.clients.forEach((client) => {
        client.close();
      });
      this.wss.close();
    }

    this.clients.clear();
    this.logger.info('🔌 WebSocket Server parado');
  }

  getStats() {
    return {
      connectedClients: this.clients.size,
      totalClients: this.wss ? this.wss.clients.size : 0
    };
  }
}
