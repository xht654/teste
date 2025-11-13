// src/streaming/FFmpegHLSManager.js
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import Logger from '../utils/Logger.js';

export default class FFmpegHLSManager {
  constructor() {
    this.logger = new Logger('FFmpegHLS');
    this.activeProcesses = new Map();
    this.hlsDir = '/app/hls'; // Diretório para arquivos HLS
    
    // Criar diretório HLS se não existir
    if (!fs.existsSync(this.hlsDir)) {
      fs.mkdirSync(this.hlsDir, { recursive: true });
    }
  }

  /**
   * Inicia FFmpeg para converter pipe → HLS
   * @param {string} pipePath - Caminho da named pipe
   * @param {string} siteId - ID do site (para organizar arquivos)
   * @param {object} options - Opções de configuração
   * @returns {Promise<string>} - Caminho do playlist .m3u8
   */
  async startHLSConversion(pipePath, siteId, options = {}) {
  const {
    segmentDuration = 6,
    playlistSize = 5,
    deleteThreshold = 10,
    
    // ✅ NOVAS OPÇÕES DVR
    enableDVR = false,              // Habilitar DVR/Timeshift
    dvrWindowSeconds = 3600,        // Janela de DVR (1 hora)
    keepAllSegments = false,        // Manter todos os segmentos (perigoso!)
    
    hlsFlags = enableDVR 
      ? 'append_list+omit_endlist'  // SEM delete_segments
      : 'delete_segments+append_list+omit_endlist',
    
    videoCodec = 'copy',
    audioCodec = 'copy',
    format = 'mpegts',
    outputFormat = 'hls'
  } = options;

  try {
    const siteHlsDir = path.join(this.hlsDir, siteId);
    if (!fs.existsSync(siteHlsDir)) {
      fs.mkdirSync(siteHlsDir, { recursive: true });
    }

    const playlistPath = path.join(siteHlsDir, 'stream.m3u8');
    const segmentPattern = path.join(siteHlsDir, 'segment_%03d.ts');

    this.logger.info(`🎬 Iniciando FFmpeg HLS para ${siteId}`);
    this.logger.info(`📂 DVR: ${enableDVR ? 'Habilitado' : 'Desabilitado'}`);

    const ffmpegArgs = [
      '-y',
      //'-fflags', '+genpts+igndts',
      '-thread_queue_size', '512',
      '-f', format,
      '-i', pipePath,
      //adicionado por mim
      '-fflags', '+genpts+igndts+nobuffer+flush_packets+discardcorrupt',
      '-flags', 'low_delay',
      //'-avioflags', 'direct', 
      '-re', 
      //
      '-c:v', videoCodec,
      '-c:a', audioCodec,
      
      '-f', outputFormat,
      '-hls_time', segmentDuration.toString(),
      '-hls_list_size', enableDVR 
        ? Math.ceil(dvrWindowSeconds / segmentDuration).toString()  // DVR: lista grande
        : playlistSize.toString(),                                   // Normal: lista pequena
      
      // ✅ CRÍTICO: delete_threshold só se não for DVR
      ...(!enableDVR ? ['-hls_delete_threshold', deleteThreshold.toString()] : []),
      
      '-hls_flags', hlsFlags,
      '-hls_segment_filename', segmentPattern,
      //adicionado por mim
      '-hls_flags', '+delete_segments+append_list+omit_endlist+temp_file+program_date_time',
      //
      // ✅ DVR: usar event playlist
      '-hls_playlist_type', enableDVR ? 'event' : 'event',
      
      '-max_muxing_queue_size', '1024',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      
      
      playlistPath
    ];

    this.logger.info(`🔧 Comando FFmpeg: ffmpeg ${ffmpegArgs.join(' ')}`);

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const processId = `${siteId}_${Date.now()}`;

    // ... resto do código igual ...

    // ✅ NOVO: Limpeza periódica de segmentos antigos (apenas se DVR habilitado)
    if (enableDVR && !keepAllSegments) {
      this.setupDVRCleanup(siteHlsDir, dvrWindowSeconds, segmentDuration);
    }

    return {
      processId,
      playlistPath,
      playlistUrl: `/hls/${siteId}/stream.m3u8`,
      siteHlsDir,
      dvrEnabled: enableDVR
    };

  } catch (error) {
    this.logger.error(`❌ Erro ao iniciar FFmpeg HLS: ${error.message}`);
    throw error;
  }
}

/**
 * ✅ NOVO: Limpeza periódica de segmentos DVR antigos
 */
setupDVRCleanup(siteHlsDir, dvrWindowSeconds, segmentDuration) {
  const maxSegments = Math.ceil(dvrWindowSeconds / segmentDuration);
  
  // Executar limpeza a cada 5 minutos
  const cleanupInterval = setInterval(() => {
    try {
      const files = fs.readdirSync(siteHlsDir)
        .filter(f => f.endsWith('.ts'))
        .map(f => ({
          name: f,
          path: path.join(siteHlsDir, f),
          mtime: fs.statSync(path.join(siteHlsDir, f)).mtimeMs
        }))
        .sort((a, b) => b.mtime - a.mtime);  // Mais recentes primeiro

      // Manter apenas os últimos maxSegments
      if (files.length > maxSegments) {
        const toDelete = files.slice(maxSegments);
        
        toDelete.forEach(file => {
          try {
            fs.unlinkSync(file.path);
            this.logger.debug(`🗑️ DVR cleanup: ${file.name}`);
          } catch (e) {
            this.logger.debug(`Erro ao deletar ${file.name}: ${e.message}`);
          }
        });
        
        if (toDelete.length > 0) {
          this.logger.info(`🗑️ DVR cleanup: ${toDelete.length} segmentos antigos removidos`);
        }
      }
    } catch (error) {
      this.logger.error(`Erro no DVR cleanup: ${error.message}`);
    }
  }, 5 * 60 * 1000);  // 5 minutos

  // Guardar referência para limpar depois
  if (!this.dvrCleanupIntervals) {
    this.dvrCleanupIntervals = new Map();
  }
  this.dvrCleanupIntervals.set(siteHlsDir, cleanupInterval);
}
  
  /**
   * Aguarda playlist ser criado
   */
  async waitForPlaylist(playlistPath, timeout = 30000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      if (fs.existsSync(playlistPath)) {
        // Verificar se tem conteúdo
        const content = fs.readFileSync(playlistPath, 'utf8');
        if (content.includes('#EXTM3U') && content.includes('.ts')) {
          this.logger.info(`✅ Playlist criado e válido: ${playlistPath}`);
          return true;
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    throw new Error(`Timeout aguardando playlist: ${playlistPath}`);
  }

  /**
   * Para um processo FFmpeg específico
   */
  stopProcess(processId) {
    const process = this.activeProcesses.get(processId);
    
    if (process) {
      this.logger.info(`🛑 Parando FFmpeg: ${processId}`);
      
      // Enviar SIGTERM
      if (process.ffmpeg && !process.ffmpeg.killed) {
        process.ffmpeg.kill('SIGTERM');
        
        // Força SIGKILL após 5s se não terminar
        setTimeout(() => {
          if (!process.ffmpeg.killed) {
            this.logger.warn(`⚠️ FFmpeg não respondeu ao SIGTERM, forçando SIGKILL`);
            process.ffmpeg.kill('SIGKILL');
          }
        }, 5000);
      }
      
      // Limpar arquivos HLS (opcional)
      this.cleanupHLS(process.siteHlsDir);
      
      this.activeProcesses.delete(processId);
      return true;
    }
    
    return false;
  }

  /**
   * Para todos os processos FFmpeg
   */
  stopAllProcesses() {
    this.logger.info('🛑 Parando todos os processos FFmpeg...');
    
    const processIds = Array.from(this.activeProcesses.keys());
    processIds.forEach(id => this.stopProcess(id));
    
    this.activeProcesses.clear();
    this.logger.info('✅ Todos os processos FFmpeg parados');
  }

  /**
   * Limpa arquivos HLS de um site
   */
  cleanupHLS(siteHlsDir) {
    try {
      if (fs.existsSync(siteHlsDir)) {
        const files = fs.readdirSync(siteHlsDir);
        
        files.forEach(file => {
          const filePath = path.join(siteHlsDir, file);
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
            this.logger.debug(`Erro ao remover ${filePath}: ${e.message}`);
          }
        });
        
        // Remover diretório
        fs.rmdirSync(siteHlsDir);
        this.logger.debug(`🗑️ Cleanup HLS concluído: ${siteHlsDir}`);
      }
    } catch (error) {
      this.logger.warn(`⚠️ Erro no cleanup HLS: ${error.message}`);
    }
  }

  /**
   * Obter estatísticas de um processo
   */
  getProcessStats(processId) {
    const process = this.activeProcesses.get(processId);
    
    if (!process) {
      return null;
    }
    
    const uptime = Date.now() - process.startTime;
    
    // Ler informações do playlist
    let segmentCount = 0;
    let playlistSize = 0;
    
    try {
      if (fs.existsSync(process.playlistPath)) {
        const content = fs.readFileSync(process.playlistPath, 'utf8');
        segmentCount = (content.match(/\.ts/g) || []).length;
        playlistSize = fs.statSync(process.playlistPath).size;
      }
    } catch (e) {
      this.logger.debug(`Erro ao ler stats do playlist: ${e.message}`);
    }
    
    return {
      processId,
      siteId: process.siteId,
      uptime,
      ffmpegPid: process.ffmpeg?.pid || null,
      ffmpegAlive: process.ffmpeg && !process.ffmpeg.killed,
      playlistPath: process.playlistPath,
      playlistUrl: `/hls/${process.siteId}/stream.m3u8`,
      segmentCount,
      playlistSize,
      hlsDir: process.siteHlsDir
    };
  }

  /**
   * Obter estatísticas de todos os processos
   */
  getAllStats() {
    const stats = [];
    
    for (const [processId, _] of this.activeProcesses) {
      const stat = this.getProcessStats(processId);
      if (stat) {
        stats.push(stat);
      }
    }
    
    return stats;
  }

  /**
   * Verificar saúde de um processo
   */
  checkHealth(processId) {
    const process = this.activeProcesses.get(processId);
    
    if (!process) {
      return { healthy: false, reason: 'Processo não encontrado' };
    }
    
    // Verificar se FFmpeg está vivo
    if (!process.ffmpeg || process.ffmpeg.killed) {
      return { healthy: false, reason: 'FFmpeg não está rodando' };
    }
    
    // Verificar se playlist existe
    if (!fs.existsSync(process.playlistPath)) {
      return { healthy: false, reason: 'Playlist não existe' };
    }
    
    // Verificar se playlist está sendo atualizado (modificado recentemente)
    try {
      const stats = fs.statSync(process.playlistPath);
      const lastModified = stats.mtimeMs;
      const timeSinceModified = Date.now() - lastModified;
      
      // Se não foi modificado em 30s, pode ter problema
      if (timeSinceModified > 30000) {
        return { 
          healthy: false, 
          reason: `Playlist não atualizado há ${Math.round(timeSinceModified / 1000)}s` 
        };
      }
    } catch (e) {
      return { healthy: false, reason: 'Erro ao verificar playlist' };
    }
    
    return { healthy: true, reason: 'OK' };
  }
}
