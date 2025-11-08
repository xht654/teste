import express from 'express';
import Logger from '../utils/Logger.js';

export default class HTTPServer {
  constructor(sessionManager, configManager) {
    this.sessionManager = sessionManager;
    this.configManager = configManager;
    this.logger = new Logger('HTTPServer');
    this.app = express();
    this.server = null;
    this.port = 8080;
  }

  async start() {
    this.setupMiddleware();
    this.setupRoutes();
    
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        this.logger.info(`🌐 Servidor HTTP ativo na porta ${this.port}`);
        this.logger.info(`📡 Streams disponíveis em: http://stream-capture:${this.port}/<site_id>/stream`);
        resolve();
      });
      
      this.server.on('error', reject);
    });
  }

  async stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          this.logger.info('⏹️ Servidor HTTP parado');
          resolve();
        });
      });
    }
  }

  setupMiddleware() {
    this.app.use(express.json());
    
    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });

    // Log de requisições
    this.app.use((req, res, next) => {
      this.logger.debug(`📥 ${req.method} ${req.url} - ${req.ip}`);
      next();
    });
  }

  setupRoutes() {
    // ROTA PRINCIPAL: Stream via chunks HTTP
    this.app.get('/:siteId/stream', (req, res) => {
      const { siteId } = req.params;
      
      this.logger.info(`📺 Nova requisição de stream: ${siteId} de ${req.ip}`);
      
      // Obter sessão ativa
      const session = this.sessionManager.activeSessions.get(siteId);
      
      if (!session) {
        this.logger.warn(`❌ Sessão não encontrada: ${siteId}`);
        res.status(404).send(`Stream '${siteId}' não está ativo`);
        return;
      }

      if (!session.isRunning) {
        this.logger.warn(`❌ Sessão não está rodando: ${siteId}`);
        res.status(503).send(`Stream '${siteId}' não está rodando`);
        return;
      }

      // Obter PipeReader da sessão
      const pipeReader = session.pipeReader;
      
      if (!pipeReader || !pipeReader.isActive()) {
        this.logger.warn(`❌ PipeReader não ativo para: ${siteId}`);
        res.status(503).send(`Stream '${siteId}' não está disponível (PipeReader inativo)`);
        return;
      }

      // Configurar headers para streaming
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Adicionar cliente ao PipeReader
      pipeReader.addClient(res);
      
      this.logger.info(`✅ Cliente conectado ao stream ${siteId} (Total clientes: ${pipeReader.clients.size})`);

      // Monitorar desconexão
      req.on('close', () => {
        this.logger.info(`❌ Cliente desconectou do stream ${siteId}`);
      });

      req.on('error', (error) => {
        this.logger.warn(`⚠️ Erro na conexão do cliente ${siteId}: ${error.message}`);
      });
    });

    // ROTA: M3U8 Playlist (compatibilidade)
    this.app.get('/:siteId/stream.m3u8', (req, res) => {
      const { siteId } = req.params;
      
      this.logger.debug(`📋 Requisição M3U8: ${siteId}`);
      
      const session = this.sessionManager.activeSessions.get(siteId);
      
      if (!session || !session.isRunning) {
        res.status(404).send(`Stream ${siteId} não ativo`);
        return;
      }

      // Gerar playlist M3U8 simples
      const m3u8Content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
http://stream-capture:${this.port}/${siteId}/stream
#EXT-X-ENDLIST
`;

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(m3u8Content);
    });

    // ROTA: Status de um stream específico
    this.app.get('/:siteId/status', (req, res) => {
      const {
        siteId } = req.params;
        const session = this.sessionManager.activeSessions.get(siteId);
  
  if (!session) {
    res.status(404).json({ error: 'Sessão não encontrada' });
    return;
  }
  
  const pipeReader = session.pipeReader;
  
  res.json({
    siteId,
    siteName: session.site.name,
    isRunning: session.isRunning,
    status: session.status,
    uptime: session.startTime ? Date.now() - session.startTime : 0,
    restartCount: session.restartCount,
    pipePath: session.currentPipePath,
    pipeReader: pipeReader ? pipeReader.getStats() : null,
    streamUrl: `http://stream-capture:${this.port}/${siteId}/stream`,
    m3u8Url: `http://stream-capture:${this.port}/${siteId}/stream.m3u8`
  });
});

// ROTA: Status global do servidor
this.app.get('/status', (req, res) => {
  const sessions = this.sessionManager.getSessionsStatus();
  const activeSessions = Object.values(sessions).filter(s => s.isRunning);
  
  const streamDetails = {};
  for (const [siteId, session] of this.sessionManager.activeSessions) {
    if (session.isRunning && session.pipeReader) {
      streamDetails[siteId] = {
        name: session.site.name,
        url: `http://stream-capture:${this.port}/${siteId}/stream`,
        m3u8: `http://stream-capture:${this.port}/${siteId}/stream.m3u8`,
        clients: session.pipeReader.clients.size,
        stats: session.pipeReader.getStats()
      };
    }
  }
  
  res.json({
    server: 'HTTP Stream Server',
    version: '2.0',
    port: this.port,
    totalSessions: Object.keys(sessions).length,
    activeSessions: activeSessions.length,
    streams: streamDetails,
    timestamp: new Date().toISOString()
  });
});

// ROTA: Lista todos os streams disponíveis
this.app.get('/streams', (req, res) => {
  const sessions = this.sessionManager.getSessionsStatus();
  const streams = {};
  
  for (const [siteId, session] of Object.entries(sessions)) {
    if (session.isRunning) {
      streams[siteId] = {
        name: session.siteName,
        url: `http://stream-capture:${this.port}/${siteId}/stream`,
        m3u8: `http://stream-capture:${this.port}/${siteId}/stream.m3u8`,
        status: session.status,
        uptime: session.uptime,
        clients: 0
      };
      
      // Adicionar contagem de clientes se PipeReader existe
      const activeSession = this.sessionManager.activeSessions.get(siteId);
      if (activeSession && activeSession.pipeReader) {
        streams[siteId].clients = activeSession.pipeReader.clients.size;
      }
    }
  }
  
  res.json(streams);
});

// ROTA: Informações detalhadas de um stream
this.app.get('/:siteId/info', (req, res) => {
  const { siteId } = req.params;
  
  const session = this.sessionManager.activeSessions.get(siteId);
  
  if (!session) {
    res.status(404).json({ error: 'Sessão não encontrada' });
    return;
  }
  
  const info = {
    siteId,
    siteName: session.site.name,
    siteUrl: session.site.url,
    status: session.status,
    isRunning: session.isRunning,
    uptime: session.startTime ? Date.now() - session.startTime : 0,
    startTime: session.startTime,
    restartCount: session.restartCount,
    pipePath: session.currentPipePath,
    streamUrls: {
      direct: `http://stream-capture:${this.port}/${siteId}/stream`,
      m3u8: `http://stream-capture:${this.port}/${siteId}/stream.m3u8`,
      status: `http://stream-capture:${this.port}/${siteId}/status`
    },
    currentStream: session.currentStream,
    pipeReader: null
  };
  
  if (session.pipeReader) {
    info.pipeReader = session.pipeReader.getStats();
  }
  
  res.json(info);
});

// ROTA: Health check
this.app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// ROTA: Root (informações do servidor)
this.app.get('/', (req, res) => {
  res.json({
    server: 'Stream Capture HTTP Server',
    version: '2.0',
    description: 'Pipe → HTTP Streaming Server',
    port: this.port,
    endpoints: {
      stream: '/:siteId/stream (HTTP chunks)',
      m3u8: '/:siteId/stream.m3u8 (M3U8 playlist)',
      status: '/status (server status)',
      streams: '/streams (list all streams)',
      info: '/:siteId/info (stream details)',
      health: '/health (health check)'
    },
    usage: {
      vlc: `vlc http://stream-capture:${this.port}/<site_id>/stream`,
      tvheadend: `http://stream-capture:${this.port}/<site_id>/stream.m3u8`,
      browser: `http://localhost:${this.port}/<site_id>/stream`
    }
  });
});

// 404 handler
this.app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'Endpoint não encontrado',
    availableEndpoints: [
      '/:siteId/stream',
      '/:siteId/stream.m3u8',
      '/:siteId/status',
      '/status',
      '/streams',
      '/health'
    ]
  });
});

// Error handler
this.app.use((err, req, res, next) => {
  this.logger.error(`❌ Erro no servidor HTTP: ${err.message}`);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});
}
}

      
