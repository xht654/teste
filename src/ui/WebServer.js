// src/ui/WebServer.js - COM WEBSOCKET
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import APIRoutes from './APIRoutes.js';
import WSNotificationServer from './WebSocketServer.js';
import Logger from '../utils/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class WebServer {
  constructor(configManager, sessionManager, vpnManager) {
    this.configManager = configManager;
    this.sessionManager = sessionManager;
    this.vpnManager = vpnManager;
    this.logger = new Logger('WebServer');
    this.app = express();
    this.server = null;
    this.wsServer = null; // ✅ NOVO
    this.port = 3001;
  }

  async start() {
    this.setupMiddleware();
    this.setupStaticFiles();
    this.setupAPIRoutes();
    
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        this.logger.info(`🌐 Web UI ativo na porta ${this.port}`);
        this.logger.info(`📍 Acesso: http://localhost:${this.port}`);
        
        // ✅ INICIAR WEBSOCKET
        this.startWebSocket();
        
        resolve();
      });
      
      this.server.on('error', reject);
    });
  }

  // ✅ NOVO: Iniciar WebSocket Server
  startWebSocket() {
    try {
      this.wsServer = new WSNotificationServer(this, this.sessionManager);
      this.wsServer.start();
      this.wsServer.startPeriodicUpdates(5000); // Atualizar a cada 5s
      
      this.logger.info('✅ WebSocket iniciado com sucesso');
    } catch (error) {
      this.logger.error('❌ Erro ao iniciar WebSocket:', error);
    }
  }

  async stop() {
    // ✅ PARAR WEBSOCKET
    if (this.wsServer) {
      this.wsServer.stop();
    }

    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          this.logger.info('⏹️ Web UI parado');
          resolve();
        });
      });
    }
  }

  setupMiddleware() {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });
  }

  setupStaticFiles() {
    const webDir = path.join(__dirname, '../../web');
    this.app.use(express.static(webDir));
    
    // Fallback para SPA
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  setupAPIRoutes() {
    const apiRoutes = new APIRoutes(
      this.configManager,
      this.sessionManager,
      this.vpnManager
    );
    
    this.app.use('/api', apiRoutes.getRouter());
  }
}
