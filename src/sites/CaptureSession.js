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
    this.currentProcessId = null;
    this.pipeReader = null; // ← NOVO: Referência ao PipeReader
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
    
    this.logger.info(`🚀 Iniciando sessão para ${this.site.name}`);
    
    try {
      // 1. DETECTAR STREAMS
      this.status = 'detecting';
      this.logger.info('🔍 Detectando streams...');
      
      const streams = await this.streamDetector.detectStreams();
      
      if (!streams || (!streams.video && !streams.audio && streams.combined.length === 0)) {
        throw new Error('❌ Nenhum stream detectado');
      }

      this.logger.info(`✅ Streams detectados: V:${!!streams.video} A:${!!streams.audio} C:${streams.combined.length}`);

      // 2. SELECIONAR MELHOR STREAM
      this.currentStream = this.selectBestStream(streams);
      this.logger.info(`📺 Stream selecionado: ${this.currentStream.type}`);

      // 3. CRIAR PIPE PATH
      this.currentPipePath = this.getPipePath();
      this.logger.info(`🔧 Pipe path: ${this.currentPipePath}`);

      // 4. CRIAR CANAIS TVHEADEND
      await this.setupTVHeadendChannel();

      // 5. INICIAR STREAMING (agora retorna o PipeReader!)
      this.status = 'streaming';
      await this.startStreamingAsync();

      // 6. INICIAR MONITORAMENTO
      this.startHealthCheck();

      this.emit('streamFound', {
        site: this.site,
        stream: this.currentStream,
        sessionId: this.getSessionId(),
        pipePath: this.currentPipePath
      });

      this.logger.info('✅ Sessão iniciada com sucesso');
      return true;

    } catch (error) {
      this.status = 'error';
      this.isRunning = false;
      this.logger.error(`❌ Erro ao iniciar sessão: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }

  async stop() {
    this.logger.info('⏹️ Parando sessão...');
    this.isRunning = false;
    this.status = 'stopping';

    try {
      // 1. PARAR MONITORAMENTO
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }

      // 2. PARAR STREAMLINK + PIPEREADER
      if (this.currentProcessId) {
        this.logger.debug(`Parando processo: ${this.currentProcessId}`);
        this.streamlinkManager.stopProcess(this.currentProcessId);
        this.currentProcessId = null;
      } else {
        // Fallback: parar todos
        this.streamlinkManager.stopAllProcesses();
      }

      // 3. LIMPAR REFERÊNCIA PIPEREADER
      this.pipeReader = null;

      // 4. REMOVER PIPE (se ainda existir)
      if (this.currentPipePath && fs.existsSync(this.currentPipePath)) {
        try {
          const stats = fs.statSync(this.currentPipePath);
          if (stats.isFIFO()) {
            fs.unlinkSync(this.currentPipePath);
            this.logger.debug(`🗑️ Pipe removida: ${this.currentPipePath}`);
          }
        } catch (error) {
          this.logger.warn(`⚠️ Erro ao remover pipe: ${error.message}`);
        }
      }

      // 5. CLEANUP TVHEADEND
      await this.tvheadend.removeChannel(this.getChannelName());

      this.status = 'stopped';
      this.emit('ended', { sessionId: this.getSessionId() });
      this.logger.info('✅ Sessão parada');

    } catch (error) {
      this.logger.error(`❌ Erro ao parar sessão: ${error.message}`);
    }
  }

  async restart() {
    this.restartCount++;
    this.logger.info(`🔄 Reiniciando sessão (tentativa ${this.restartCount})...`);

    try {
      await this.stop();
      await new Promise(resolve => setTimeout(resolve, 3000));
      await this.start();
      return true;
    } catch (error) {
      this.logger.error(`❌ Erro ao reiniciar sessão: ${error.message}`);
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
    
    // Criar canal HTTP (principal)
    const httpUrl = `http://stream-capture:8080/${this.site.id}/stream`;
    await this.tvheadend.createHttpChannel(channelName, httpUrl);
    
    this.logger.info(`📺 Canal TVHeadend criado: ${channelName}`);
    this.logger.info(`🔗 URL: ${httpUrl}`);
  }

  /**
   * MODIFICADO: Agora guarda referência ao PipeReader
   */
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
        timeout: 600
      };

      this.logger.info(`📡 Iniciando Streamlink para: ${streamUrl.substring(0, 80)}...`);
      this.logger.debug(`⚙️ Opções: quality=${options.quality}, referer=${options.referer ? 'sim' : 'não'}`);
      
      // Streamlink agora cria o PipeReader internamente
      const success = await this.streamlinkManager.streamToOutput(
        streamUrl,
        this.currentPipePath,
        options
      );

      // Obter referência ao PipeReader criado
      const allReaders = this.streamlinkManager.getAllPipeReaders();
      if (allReaders.size > 0) {
        // Pegar o mais recente (último adicionado)
        const readersArray = Array.from(allReaders.values());
        this.pipeReader = readersArray[readersArray.length - 1];
        
        if (this.pipeReader) {
          this.logger.info(`✅ PipeReader obtido - ${this.pipeReader.clients.size} clientes conectados`);
        }
      }

      if (!success && this.isRunning) {
        this.logger.warn('⚠️ Streamlink terminou sem sucesso, tentando restart...');
        setTimeout(() => {
          if (this.isRunning) {
            this.restart();
          }
        }, 5000);
      }

    } catch (error) {
      this.logger.error(`❌ Erro no streaming: ${error.message}`);
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
    
    this.logger.debug(`💓 Health check iniciado (intervalo: ${interval}s)`);
  }

  async performHealthCheck() {
    if (!this.isRunning) return;

    try {
      const uptime = Date.now() - this.startTime;
      const maxUptime = this.configManager.config.streaming?.autoRestart?.tokenExpiryCheck || 1800;

      // Verificar se token expirou (30 minutos padrão)
      if (uptime > maxUptime * 1000) {
        this.logger.info('⏱️ Token pode ter expirado, reiniciando sessão...');
        await this.restart();
        return;
      }

      // Verificar se pipe ainda existe
      if (this.currentPipePath && !fs.existsSync(this.currentPipePath)) {
        this.logger.warn('⚠️ Pipe não existe mais, recriando sessão...');
        await this.restart();
        return;
      }

      // Verificar se PipeReader está ativo
      if (this.pipeReader && !this.pipeReader.isActive()) {
        this.logger.warn('⚠️ PipeReader não está ativo, reiniciando...');
        await this.restart();
        return;
      }

      // Log de estatísticas periódicas
      if (this.pipeReader) {
        const stats = this.pipeReader.getStats();
        this.logger.debug(`📊 Health: Uptime=${this.formatUptime(uptime)}, Clientes=${stats.clients}, Buffer=${this.formatBytes(stats.bufferSize)}`);
      }

    } catch (error) {
      this.logger.error(`❌ Erro no health check: ${error.message}`);
    }
  }

  getStatus() {
    const status = {
      sessionId: this.getSessionId(),
      siteId: this.site.id,
      siteName: this.site.name,
      status: this.status,
      startTime: this.startTime,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      restartCount: this.restartCount,
      currentStream: this.currentStream,
      isRunning: this.isRunning,
      pipePath: this.currentPipePath,
      pipeReader: null
    };

    // Adicionar stats do PipeReader se disponível
    if (this.pipeReader) {
      status.pipeReader = this.pipeReader.getStats();
    }

    return status;
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

  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
