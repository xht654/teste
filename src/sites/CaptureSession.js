// src/sites/CaptureSession.js (MODIFICADO)
import EventEmitter from 'events';
import fs from 'fs';
import StreamDetector from '../core/StreamDetector.js';
import StreamlinkManager from '../streaming/StreamlinkManager.js';
import FFmpegHLSManager from '../streaming/FFmpegHLSManager.js';
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
    this.ffmpegHLSManager = new FFmpegHLSManager(); // ✅ NOVO
    this.tvheadend = new TVHeadendIntegration(configManager);
    
    this.status = 'idle';
    this.startTime = null;
    this.currentStream = null;
    this.currentPipePath = null;
    this.streamlinkProcessId = null;
    this.ffmpegProcessId = null; // ✅ NOVO
    this.hlsInfo = null; // ✅ NOVO
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

      // 3. CRIAR PIPE
      this.currentPipePath = this.getPipePath();
      await this.createPipe(this.currentPipePath);
      this.logger.info(`🔧 Pipe criada: ${this.currentPipePath}`);

      // 4. ✅ INICIAR FFMPEG PRIMEIRO (abre a pipe para leitura)
      this.status = 'streaming';
      this.startFFmpegHLS(); // ← NÃO usar await aqui!
      
      // Aguardar FFmpeg abrir a pipe (2 segundos)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 5. INICIAR STREAMLINK (escreve na pipe - agora não bloqueia!)
      this.startStreamlink(); // ← NÃO usar await aqui também!

      // 6. CRIAR CANAIS TVHEADEND (aguardar HLS estar pronto)
      await new Promise(resolve => setTimeout(resolve, 5000));
      await this.setupTVHeadendChannel();

      // 7. INICIAR MONITORAMENTO
      this.startHealthCheck();

      this.emit('streamFound', {
        site: this.site,
        stream: this.currentStream,
        sessionId: this.getSessionId(),
        pipePath: this.currentPipePath,
        hlsPlaylist: this.hlsInfo?.playlistUrl // ✅ NOVO
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

      // 2. ✅ PARAR FFMPEG
      if (this.ffmpegProcessId) {
        this.logger.debug(`Parando FFmpeg: ${this.ffmpegProcessId}`);
        this.ffmpegHLSManager.stopProcess(this.ffmpegProcessId);
        this.ffmpegProcessId = null;
      }

      // 3. PARAR STREAMLINK
      if (this.streamlinkProcessId) {
        this.logger.debug(`Parando Streamlink: ${this.streamlinkProcessId}`);
        this.streamlinkManager.stopProcess(this.streamlinkProcessId);
        this.streamlinkProcessId = null;
      }

      // 4. REMOVER PIPE
      if (this.currentPipePath && fs.existsSync(this.currentPipePath)) {
        try {
          fs.unlinkSync(this.currentPipePath);
          this.logger.debug(`🗑️ Pipe removida: ${this.currentPipePath}`);
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

  async createPipe(pipePath) {
    try {
      if (fs.existsSync(pipePath)) {
        fs.unlinkSync(pipePath);
      }

      const { execSync } = await import('child_process');
      execSync(`mkfifo "${pipePath}"`);
      fs.chmodSync(pipePath, 0o666);
      
      this.logger.info(`✅ Pipe criada: ${pipePath}`);
      return true;
    } catch (error) {
      this.logger.error(`❌ Erro ao criar pipe: ${error.message}`);
      throw error;
    }
  }

  /**
   * Inicia Streamlink (não aguarda finalização - roda em background)
   */
  startStreamlink() {
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

    this.logger.info(`📡 Iniciando Streamlink → Pipe`);
    
    // Iniciar de forma assíncrona (não esperar)
    this.streamlinkManager.streamToPipe(
      streamUrl,
      this.currentPipePath,
      options
    ).then(processId => {
      this.streamlinkProcessId = processId;
      this.logger.info(`✅ Streamlink iniciado (ID: ${processId})`);
    }).catch(error => {
      this.logger.error(`❌ Erro no Streamlink: ${error.message}`);
      if (this.isRunning) {
        setTimeout(() => this.restart(), 5000);
      }
    });
  }

  /**
   * ✅ NOVO: Inicia FFmpeg para ler pipe e gerar HLS
   */
  async startFFmpegHLS() {
    try {
      this.logger.info(`🎬 Iniciando FFmpeg HLS...`);

      const options = {
        segmentDuration: 6,        // 6s por segmento
        playlistSize: 5,            // 5 segmentos no playlist (30s)
        deleteThreshold: 10,        // Deletar segmentos antigos
        videoCodec: 'copy',         // Não recodificar (performance)
        audioCodec: 'copy',
        hlsFlags: 'delete_segments+append_list+omit_endlist'
      };

      const hlsInfo = await this.ffmpegHLSManager.startHLSConversion(
        this.currentPipePath,
        this.site.id,
        options
      );

      this.ffmpegProcessId = hlsInfo.processId;
      this.hlsInfo = hlsInfo;

      this.logger.info(`✅ FFmpeg HLS pronto!`);
      this.logger.info(`📝 Playlist: ${hlsInfo.playlistUrl}`);

    } catch (error) {
      this.logger.error(`❌ Erro ao iniciar FFmpeg HLS: ${error.message}`);
      throw error;
    }
  }

  async setupTVHeadendChannel() {
    const channelName = this.getChannelName();
    
    // ✅ USAR HLS em vez de pipe direta
    const hlsUrl = `http://stream-capture:8080${this.hlsInfo.playlistUrl}`;
    
    await this.tvheadend.createHttpChannel(channelName, hlsUrl);
    
    this.logger.info(`📺 Canal TVHeadend criado: ${channelName}`);
    this.logger.info(`🔗 URL HLS: ${hlsUrl}`);
  }

  async performHealthCheck() {
    if (!this.isRunning) return;

    try {
      // Verificar FFmpeg
      if (this.ffmpegProcessId) {
        const health = this.ffmpegHLSManager.checkHealth(this.ffmpegProcessId);
        
        if (!health.healthy) {
          this.logger.warn(`⚠️ FFmpeg unhealthy: ${health.reason}`);
          await this.restart();
          return;
        }
      }

      // Verificar Streamlink (via processo ativo)
      if (this.streamlinkProcessId) {
        const process = this.streamlinkManager.activeProcesses.get(this.streamlinkProcessId);
        if (!process || !process.streamlink || process.streamlink.killed) {
          this.logger.warn('⚠️ Streamlink morreu, reiniciando...');
          await this.restart();
          return;
        }
      }

      // Log de estatísticas periódicas
      const uptime = Date.now() - this.startTime;
      if (uptime % 60000 < 10000) { // A cada ~1 minuto
        const stats = this.ffmpegHLSManager.getProcessStats(this.ffmpegProcessId);
        if (stats) {
          this.logger.info(`📊 Health OK: Uptime=${this.formatUptime(uptime)}, Segments=${stats.segmentCount}`);
        }
      }

    } catch (error) {
      this.logger.error(`❌ Erro no health check: ${error.message}`);
    }
  }

  startHealthCheck() {
    const interval = 30; // 30 segundos
    
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, interval * 1000);
    
    this.logger.debug(`💓 Health check iniciado (intervalo: ${interval}s)`);
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
      hlsInfo: null,
      ffmpegStats: null
    };

    // ✅ Adicionar info HLS
    if (this.hlsInfo) {
      status.hlsInfo = this.hlsInfo;
    }

    // ✅ Adicionar stats do FFmpeg
    if (this.ffmpegProcessId) {
      status.ffmpegStats = this.ffmpegHLSManager.getProcessStats(this.ffmpegProcessId);
    }

    return status;
  }

  selectBestStream(streams) {
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

    return null;
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
}
