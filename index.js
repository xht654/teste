import ConfigManager from './src/config/ConfigManager.js';
import SessionManager from './src/core/SessionManager.js';
import VPNManager from './src/network/VPNManager.js';
import WebServer from './src/ui/WebServer.js';
import Logger from './src/utils/Logger.js';

class StreamCaptureApp {
  constructor() {
    this.logger = new Logger('App');
    this.configManager = new ConfigManager();
    this.sessionManager = null;
    this.vpnManager = null;
    this.webServer = null;
  }

  async initialize() {
    try {
      // Carregar configuração
      await this.configManager.loadConfig();
      this.logger.info('Configuração carregada');

      // Inicializar módulos
      this.sessionManager = new SessionManager(this.configManager);
      this.vpnManager = new VPNManager(this.configManager);
      this.webServer = new WebServer(this.configManager, this.sessionManager, this.vpnManager);

      // Conectar VPN se habilitada
      await this.vpnManager.connect();

      // Iniciar servidor web
      await this.webServer.start();

      // Iniciar captura automática
      await this.startAutomaticCapture();

      this.logger.info('🚀 Sistema iniciado com sucesso');
    } catch (error) {
      this.logger.error('Erro na inicialização:', error);
      process.exit(1);
    }
  }

  async startAutomaticCapture() {
    // Iniciar captura paralela de sites habilitados
    try {
      await this.sessionManager.startParallelCapture();
    } catch (error) {
      this.logger.error('Erro na captura automática:', error);
    }
  }

  async shutdown() {
    this.logger.info('Encerrando sistema...');
    
    try {
      await this.sessionManager?.stopAllSessions();
      await this.vpnManager?.disconnect();
      await this.webServer?.stop();
    } catch (error) {
      this.logger.error('Erro no shutdown:', error);
    }
    
    process.exit(0);
  }
}

// Inicializar aplicação
const app = new StreamCaptureApp();
await app.initialize();

// Tratamento de sinais
process.on('SIGTERM', () => app.shutdown());
process.on('SIGINT', () => app.shutdown());

