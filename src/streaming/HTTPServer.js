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
        this.logger.info(`Servidor HTTP ativo na porta ${this.port}`);
        resolve();
      });
      
      this.server.on('error', reject);
    });
  }

  async stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          this.logger.info('Servidor HTTP parado');
          resolve();
        });
      });
    }
  }

  setupMiddleware() {
    this.app.use(express.json());
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });
  }

  setupRoutes() {
    // Rota principal de stream (global)
    this.app.get('/stream.m3u8', (req, res) => {
      const sessions = this.sessionManager.getSessionsStatus();
      const activeSessions = Object.values(sessions).filter(s => s.isRunning);
      
      if (activeSessions.length === 0) {
        res.status(404).send('Nenhum stream ativo');
        return;
      }
      
      // Retornar primeiro stream ativo
      const session = activeSessions[0];
      const streamUrl = this.getStreamUrl(session.currentStream);
      
      if (streamUrl) {
        this.logger.debug(`Redirecionamento global: ${streamUrl.substring(0, 100)}...`);
        res.redirect(streamUrl);
      } else {
        res.status(404).send('Stream não disponível');
      }
    });

    // Rotas específicas por site
    this.app.get('/:siteId/stream.m3u8', (req, res) => {
      const { siteId } = req.params;
      const sessions = this.sessionManager.getSessionsStatus();
      const session = sessions[siteId];
      
      if (!session || !session.isRunning) {
        res.status(404).send(`Stream ${siteId} não ativo`);
        return;
      }
      
      const streamUrl = this.getStreamUrl(session.currentStream);
      
      if (streamUrl) {
        this.logger.debug(`Redirecionamento ${siteId}: ${streamUrl.substring(0, 100)}...`);
        res.redirect(streamUrl);
      } else {
        res.status(404).send('Stream não disponível');
      }
    });

    // Status de um site específico
    this.app.get('/:siteId/status', (req, res) => {
      const { siteId } = req.params;
      const sessions = this.sessionManager.getSessionsStatus();
      const session = sessions[siteId];
      
      if (!session) {
        res.status(404).json({ error: 'Sessão não encontrada' });
        return;
      }
      
      res.json(session);
    });

    // Status global
    this.app.get('/status', (req, res) => {
      const sessions = this.sessionManager.getSessionsStatus();
      const activeSessions = Object.values(sessions).filter(s => s.isRunning);
      
      res.json({
        totalSessions: Object.keys(sessions).length,
        activeSessions: activeSessions.length,
        sessions: sessions,
        timestamp: new Date().toISOString()
      });
    });

    // Lista de streams disponíveis
    this.app.get('/streams', (req, res) => {
      const sessions = this.sessionManager.getSessionsStatus();
      const streams = {};
      
      Object.entries(sessions).forEach(([siteId, session]) => {
        if (session.isRunning && session.currentStream) {
          streams[siteId] = {
            name: session.siteName,
            url: `/api/streams/${siteId}/stream.m3u8`,
            type: session.currentStream.type,
            uptime: session.uptime,
            status: session.status
          };
        }
      });
      
      res.json(streams);
    });

    // Informações detalhadas de um stream
    this.app.get('/:siteId/info', (req, res) => {
      const { siteId } = req.params;
      const sessions = this.sessionManager.getSessionsStatus();
      const session = sessions[siteId];
      
      if (!session) {
        res.status(404).json({ error: 'Sessão não encontrada' });
        return;
      }
      
      res.json({
        ...session,
        streamUrl: session.currentStream ? this.getStreamUrl(session.currentStream) : null,
        httpUrl: `/${siteId}/stream.m3u8`
      });
    });
  }

  getStreamUrl(streamConfig) {
    if (!streamConfig) return null;
    
    switch (streamConfig.type) {
      case 'separate':
        return streamConfig.video;
      case 'combined':
      case 'video-only':
      case 'audio-only':
        return streamConfig.url;
      default:
        return null;
    }
  }
}
