import EventEmitter from 'events';
import StreamDetector from '../core/StreamDetector.js';
import StreamlinkManager from '../streaming/StreamlinkManager.js';
import TVHeadendIntegration from '../streaming/TVHeadendIntegration.js';
import Logger from '../utils/Logger.js';

export default class CaptureSession extends EventEmitter {
  constructor(site, configManager) {
    super();
    this.site = site;
    this.configManager = configManager;
    this.logger = new Logger(`Session:${site.id}`);
    
    this.streamDetector = new StreamDetector(site);
    this.streamlinkManager = new StreamlinkManager();
    this.tvheadend = new TVHeadendIntegration(configManager);
    
    this.status = 'idle';
    this.startTime = null;
    this.currentStream = null;
    this.restartCount = 0;
    this.isRunning = false;
    this.healthCheckInterval = null;
  }

  async start() {
    if (this.isRunning) {
      throw new Error(`Sessão ${this.site.id} já está em execução`);
    }

    this.isRunning = true;
    this.status = 'starting';
    this.startTime = Date.now();
    
    this.logger.info(`Iniciando sessão para ${this.site.name}`);
    
    try {
      // Detectar streams
      this.status = 'detecting';
      const streams = await this.streamDetector.detectStreams();
      
      if (!streams || (!streams.video && !streams.audio && streams.combined.length === 0)) {
        throw new Error('Nenhum stream detectado');
      }

      // Selecionar melhor stream
      this.currentStream = this.selectBestStream(streams);
      this.logger.info(`Stream selecionado: ${this.currentStream.type}`);

      // Criar canal TVHeadend
      await this.setupTVHeadendChannel();

      // Iniciar streaming
      this.status = 'streaming';
      await this.startStreaming();

      // Iniciar monitoramento
      this.startHealthCheck();

      this.emit('streamFound', {
        site: this.site,
        stream: this.currentStream,
        sessionId: this.getSessionId()
      });

      this.logger.info('Sessão iniciada com sucesso');
      return true;

    } catch (error) {
      this.status = 'error';
      this.logger.error('Erro ao iniciar sessão:', error);
      this.emit('error', error);
      throw error;
    }
  }

  async stop() {
    this.logger.info('Parando sessão...');
    this.isRunning = false;
    this.status = 'stopping';

    try {
      // Parar monitoramento
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      // Parar streaming
      await this.stopStreaming();

      // Cleanup TVHeadend
      await this.tvheadend.removeChannel(this.getChannelName());

      this.status = 'stopped';
      this.emit('ended', { sessionId: this.getSessionId() });
      this.logger.info('Sessão parada');

    } catch (error) {
      this.logger.error('Erro ao parar sessão:', error);
    }
  }

  async restart() {
    this.restartCount++;
    this.logger.info(`Reiniciando sessão (tentativa ${this.restartCount})...`);

    try {
      await this.stop();
      await new Promise(resolve => setTimeout(resolve, 3000)); // Aguardar 3s
      await this.start();
      return true;
    } catch (error) {
      this.logger.error('Erro ao reiniciar sessão:', error);
      return false;
    }
  }

  selectBestStream(streams) {
    // Priorizar streams combinados para melhor compatibilidade
    if (streams.combined.length > 0) {
      return {
        type: 'combined',
        url: streams.combined[0],
        quality: 'best'
      };
    }

    if (streams.video && streams.audio) {
      return {
        type: 'separate',
        video: streams.video,
        audio: streams.audio,
        quality: 'best'
      };
    }

    if (streams.video) {
      return {
        type: 'video-only',
        url: streams.video,
        quality: 'best'
      };
    }

    if (streams.audio) {
      return {
        type: 'audio-only',
        url: streams.audio,
        quality: 'best'
      };
    }

    return null;
  }

  async setupTVHeadendChannel() {
    const channelName = this.getChannelName();
    const pipePath = this.getPipePath();
    
    // Criar canal pipe
    await this.tvheadend.createPipeChannel(channelName, pipePath);
    
    // Criar canal HTTP (backup)
    const httpUrl = `http://stream_capture:8080/${this.site.id}/stream.m3u8`;
    await this.tvheadend.createHttpChannel(`${channelName}_http`, httpUrl);
    
    this.logger.info(`Canais TVHeadend criados: ${channelName}`);
  }

  async startStreaming() {
    const streamUrl = this.currentStream.type === 'separate' 
      ? this.currentStream.video 
      : this.currentStream.url;

    const options = {
      quality: this.site.streamlink?.quality || 'best',
      referer: this.site.referer || this.site.url, // NOVO: Suporte a referer
      userAgent: this.site.userAgent,
      retryStreams: this.site.streamlink?.retryStreams || 3,
      retryMax: this.site.streamlink?.retryMax || 5,
      customArgs: this.site.streamlink?.customArgs || '',
      timeout: this.configManager.config.streaming?.timeout || 300
    };

    const success = await this.streamlinkManager.streamToOutput(
      streamUrl,
      this.getPipePath(),
      options
    );

    if (!success) {
      throw new Error('Falha ao iniciar Streamlink');
    }
  }

  async stopStreaming() {
    // O Streamlink será parado automaticamente quando a sessão for interrompida
    // Aqui podemos adicionar limpeza adicional se necessário
  }

  startHealthCheck() {
    const interval = this.configManager.config.streaming?.autoRestart?.healthCheckInterval || 300;
    
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, interval * 1000);
  }

  async performHealthCheck() {
    if (!this.isRunning) return;

    try {
      const uptime = Date.now() - this.startTime;
      const maxUptime = this.configManager.config.streaming?.autoRestart?.tokenExpiryCheck || 1800;

      // Verificar se token expirou
      if (uptime > maxUptime * 1000) {
        this.logger.info('Token expirado, reiniciando sessão...');
        await this.restart();
        return;
      }

      // Verificar se pipe ainda existe e está ativo
      const pipePath = this.getPipePath();
      if (!await this.tvheadend.isPipeActive(pipePath)) {
        this.logger.warn('Pipe inativo, reiniciando...');
        await this.restart();
      }

    } catch (error) {
      this.logger.error('Erro no health check:', error);
    }
  }

  getStatus() {
    return {
      sessionId: this.getSessionId(),
      siteId: this.site.id,
      siteName: this.site.name,
      status: this.status,
      startTime: this.startTime,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      restartCount: this.restartCount,
      currentStream: this.currentStream,
      isRunning: this.isRunning
    };
  }

  getSessionId() {
    return `${this.site.id}_${this.startTime}`;
  }

  getChannelName() {
    return `stream_${this.site.id}`;
  }

  getPipePath() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `/app/timeshift/stream_${this.site.id}_${timestamp}.pipe`;
  }
}
