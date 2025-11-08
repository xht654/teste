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
