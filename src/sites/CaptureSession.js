import EventEmitter from 'events';
import fs from 'fs';
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
    this.currentPipePath = null;
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

      // Criar pipe path
      this.currentPipePath = this.getPipePath();

      // Criar canal TVHeadend
      await this.setupTVHeadendChannel();

      // Iniciar streaming (async, não aguardar)
      this.status = 'streaming';
      this.startStreamingAsync();

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
      this.isRunning = false;
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
      this.streamlinkManager.stopAllProcesses();

      // Cleanup pipe
      if (this.currentPipePath && fs.existsSync(this.currentPipePath)) {
        try {
          fs.unlinkSync(this.currentPipePath);
          this.logger.debug(`Pipe removida: ${this.currentPipePath}`);
        } catch (error) {
          this.logger.warn(`Erro ao remover pipe: ${error.message}`);
        }
      }

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
      await new Promise(resolve => setTimeout(resolve, 3000));
      await this.start();
      return true;
    } catch (error) {
      this.logger.error('Erro ao reiniciar sessão:', error);
      return false;
    }
  }

  selectBestStream(streams) {
    // Priorizar streams combinados
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
    
    // Criar canal pipe
    await this.tvheadend.createPipeChannel(channelName, this.currentPipePath);
    
    // Criar canal HTTP (backup)
    const httpUrl = `http://stream-capture:8080/${this.site.id}/stream.m3u8`;
    await this.tvheadend.createHttpChannel(`${channelName}_http`, httpUrl);
    
    this.logger.info(`Canais TVHeadend criados: ${channelName}`);
  }

  // Iniciar streaming de forma assíncrona
  async startStreamingAsync() {
    try {
      const streamUrl = this.currentStream.type === 'separate' 
        ? this.currentStream.video 
        : this.currentStream.url;

      const options = {
        quality: this.site.streamlink?.quality || 'best',
        referer: this.site.referer || this.site.url,
        userAgent: this.site.userAgent,
        retryStreams: this.site.streamlink?.retryStreams || 3,
        retryMax: this.site.streamlink?.retryMax || 5,
        customArgs: this.site.streamlink?.customArgs || '',
        timeout: 600 // 10 minutos
      };

      this.logger.info('Iniciando Streamlink...');
      
      const success = await this.streamlinkManager.streamToOutput(
        streamUrl,
        this.currentPipePath,
        options
      );

      if (!success && this.isRunning) {
        this.logger.warn('Streamlink terminou sem sucesso, tentando restart...');
        setTimeout(() => {
          if (this.isRunning) {
            this.restart();
          }
        }, 5000);
      }

    } catch (error) {
      this.logger.error('Erro no streaming:', error);
      if (this.isRunning) {
        setTimeout(() => this.restart(), 5000);
      }
    }
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

      // Verificar se token expirou (30 minutos)
      if (uptime > maxUptime * 1000) {
        this.logger.info('Token pode ter expirado, reiniciando sessão...');
        await this.restart();
        return;
      }

      // Verificar se pipe ainda existe
      if (this.currentPipePath && !fs.existsSync(this.currentPipePath)) {
        this.logger.warn('Pipe não existe mais, recriando...');
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
      isRunning: this.isRunning,
      pipePath: this.currentPipePath
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
