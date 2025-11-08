import { spawn } from 'child_process';
import fs from 'fs';
import Logger from '../utils/Logger.js';
import PipeReader from './PipeReader.js';

export default class StreamlinkManager {
  constructor() {
    this.logger = new Logger('StreamlinkManager');
    this.activeProcesses = new Map();
  }

  /**
   * Inicia streaming via Pipe → PipeReader
   */
  async streamToOutput(streamUrl, outputPath, options = {}) {
    const {
      quality = 'best',
      referer = null,
      userAgent = null,
      retryStreams = 3,
      retryMax = 5,
      customArgs = '',
      timeout = 600
    } = options;

    try {
      this.logger.info(`🚀 Iniciando captura via PIPE para: ${outputPath}`);
      
      // 1. CRIAR PIPE
      await this.createPipe(outputPath);
      
      // 2. INICIAR PIPE READER (antes do Streamlink!)
      const pipeReader = new PipeReader(outputPath, {
        bufferDuration: 60,
        maxBufferSize: 10 * 1024 * 1024 // 10MB
      });

      // Event listeners do PipeReader
      pipeReader.on('ready', () => {
        this.logger.info('✅ PipeReader pronto e aguardando dados');
      });

      pipeReader.on('error', (error) => {
        this.logger.error(`❌ Erro no PipeReader: ${error.message}`);
      });

      pipeReader.on('end', () => {
        this.logger.warn('⚠️ PipeReader encerrado (Streamlink parou de escrever)');
      });

      // Iniciar leitura da pipe
      await pipeReader.start();
      
      // Aguardar pipe estar pronta
      await new Promise(resolve => setTimeout(resolve, 500));

      // 3. ARGUMENTOS STREAMLINK
      const streamlinkArgs = [
        '--loglevel', 'info',
        '--output', outputPath, // ← PIPE (não .ts)
        '--force',
        '--retry-streams', retryStreams.toString(),
        '--retry-max', retryMax.toString(),
        '--stream-segment-timeout', '60.0',
        '--hls-live-restart',
        '--ringbuffer-size', '512K', // Buffer pequeno para baixa latência
        '--stream-types', 'hls'
      ];

      if (referer) {
        streamlinkArgs.push('--http-header', `Referer=${referer}`);
        this.logger.info(`🔗 Usando referer: ${referer}`);
      }

      if (userAgent) {
        streamlinkArgs.push('--http-header', `User-Agent=${userAgent}`);
      }

      if (customArgs && customArgs.trim()) {
        const customArgArray = customArgs.trim().split(/\s+/);
        streamlinkArgs.push(...customArgArray);
        this.logger.info(`⚙️ Argumentos personalizados: ${customArgs}`);
      }

      streamlinkArgs.push(streamUrl, quality);

      const streamlinkCmd = `streamlink ${streamlinkArgs.join(' ')}`;
      this.logger.info(`📝 Comando Streamlink: ${streamlinkCmd.substring(0, 150)}...`);
      this.logger.info(`🔧 Saída: PIPE → ${outputPath}`);

      // 4. INICIAR STREAMLINK
      return new Promise((resolve, reject) => {
        this.logger.debug('🎬 Iniciando processo Streamlink...');
        
        const streamlinkProcess = spawn('streamlink', streamlinkArgs, {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        streamlinkProcess.on('spawn', () => {
          this.logger.info(`✅ Streamlink iniciado (PID: ${streamlinkProcess.pid})`);
        });

        const processId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Guardar referências
        this.activeProcesses.set(processId, {
          streamlink: streamlinkProcess,
          pipeReader: pipeReader,
          pipePath: outputPath,
          startTime: Date.now()
        });

        let isStable = false;
        let hasError = false;
        const startTime = Date.now();

        // Monitorar quando PipeReader começa a receber dados
        const dataListener = () => {
          if (!isStable) {
            isStable = true;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            this.logger.info(`✅ Stream estável após ${elapsed}s - Dados fluindo pela pipe!`);
          }
        };

        pipeReader.once('data', dataListener);

        // Timeout para detectar stream estável
        const stabilityTimeout = setTimeout(() => {
          if (!isStable) {
            this.logger.warn('⚠️ Stream não estabilizou em 15s, mas continuando...');
          }
        }, 15000);

        // LOGS STREAMLINK STDOUT
        streamlinkProcess.stdout.on('data', (data) => {
          const output = data.toString().trim();
          if (output) {
            this.logger.debug(`[Streamlink STDOUT] ${output}`);
          }
        });

        // LOGS STREAMLINK STDERR
        streamlinkProcess.stderr.on('data', (data) => {
          const output = data.toString();
          
          if (output.trim()) {
            // Filtrar logs de segmentos (muito verboso)
            if (!output.includes('segment') && !output.includes('Opening stream')) {
              this.logger.debug(`[Streamlink] ${output.trim()}`);
            }
          }
          
          // Detectar mensagens importantes
          if (output.includes('[cli][info]')) {
            const cleanOutput = output.replace('[cli][info]', '').trim();
            if (cleanOutput && !cleanOutput.includes('segment')) {
              this.logger.info(`📡 Streamlink: ${cleanOutput}`);
            }
          }
          
          // Detectar erros
          if (output.includes('error:') || output.includes('Failed to') || output.includes('Unable to')) {
            this.logger.error(`❌ Streamlink ERROR: ${output.trim()}`);
            hasError = true;
          }

          // Detectar quando stream inicia
          if (output.includes('Opening stream') || output.includes('Writing output')) {
            this.logger.info('📺 Streamlink iniciou escrita na pipe');
          }
        });

        // STREAMLINK EXIT
        streamlinkProcess.on('close', (code) => {
          clearTimeout(stabilityTimeout);
          pipeReader.off('data', dataListener);
          
          const duration = Math.round((Date.now() - startTime) / 1000);
          this.logger.info(`⏹️ Streamlink terminou com código ${code} após ${duration}s`);
          
          // Parar PipeReader
          if (pipeReader.isActive()) {
            this.logger.debug('Parando PipeReader...');
            pipeReader.stop();
          }

          // Cleanup
          this.activeProcesses.delete(processId);
          
          // Determinar sucesso
          if (code === 0 || (isStable && code !== 1)) {
            resolve(true);
          } else if (hasError) {
            resolve(false);
          } else {
            resolve(isStable);
          }
        });

        // STREAMLINK ERROR
        streamlinkProcess.on('error', (error) => {
          clearTimeout(stabilityTimeout);
          this.logger.error(`❌ Erro ao iniciar Streamlink: ${error.message}`);
          
          if (pipeReader.isActive()) {
            pipeReader.stop();
          }
          
          this.activeProcesses.delete(processId);
          reject(error);
        });

        // TIMEOUT GLOBAL
        const timeoutHandle = setTimeout(() => {
          if (!streamlinkProcess.killed) {
            this.logger.warn(`⏱️ Timeout após ${timeout}s - Encerrando Streamlink`);
            streamlinkProcess.kill('SIGTERM');
            setTimeout(() => {
              if (!streamlinkProcess.killed) {
                streamlinkProcess.kill('SIGKILL');
              }
            }, 5000);
          }
        }, timeout * 1000);

        streamlinkProcess.on('close', () => {
          clearTimeout(timeoutHandle);
        });
      });

    } catch (error) {
      this.logger.error(`❌ Erro ao iniciar streaming: ${error.message}`);
      throw error;
    }
  }

  /**
   * Criar named pipe
   */
  async createPipe(pipePath) {
    try {
      // Remover pipe antiga se existir
      if (fs.existsSync(pipePath)) {
        const stats = fs.statSync(pipePath);
        
        if (stats.isFIFO()) {
          this.logger.debug(`🗑️ Removendo pipe antiga: ${pipePath}`);
          fs.unlinkSync(pipePath);
        } else {
          // Se for arquivo normal, remover também
          this.logger.warn(`⚠️ ${pipePath} não é uma pipe, removendo arquivo`);
          fs.unlinkSync(pipePath);
        }
      }

      // Criar nova pipe
      const { execSync } = await import('child_process');
      execSync(`mkfifo "${pipePath}"`);
      fs.chmodSync(pipePath, 0o666);
      
      this.logger.info(`✅ Named pipe criada: ${pipePath}`);
      
      // Verificar se foi criada corretamente
      const stats = fs.statSync(pipePath);
      if (!stats.isFIFO()) {
        throw new Error('Falha ao criar pipe: arquivo criado não é FIFO');
      }
      
      return true;
    } catch (error) {
      this.logger.error(`❌ Erro ao criar pipe: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obter PipeReader de um processo ativo
   */
  getPipeReader(processId) {
    const process = this.activeProcesses.get(processId);
    return process ? process.pipeReader : null;
  }

  /**
   * Obter todos os PipeReaders ativos
   */
  getAllPipeReaders() {
    const readers = new Map();
    for (const [id, process] of this.activeProcesses) {
      if (process.pipeReader) {
        readers.set(id, process.pipeReader);
      }
    }
    return readers;
  }

  /**
   * Parar processo específico
   */
  stopProcess(processId) {
    const processes = this.activeProcesses.get(processId);
    
    if (processes) {
      this.logger.info(`🛑 Parando processo: ${processId}`);
      
      // Parar Streamlink
      if (processes.streamlink && !processes.streamlink.killed) {
        processes.streamlink.kill('SIGTERM');
        setTimeout(() => {
          if (!processes.streamlink.killed) {
            processes.streamlink.kill('SIGKILL');
          }
        }, 5000);
      }
      
      // Parar PipeReader
      if (processes.pipeReader && processes.pipeReader.isActive()) {
        processes.pipeReader.stop();
      }
      
      // Remover pipe
      if (processes.pipePath && fs.existsSync(processes.pipePath)) {
        try {
          fs.unlinkSync(processes.pipePath);
          this.logger.debug(`🗑️ Pipe removida: ${processes.pipePath}`);
        } catch (error) {
          this.logger.warn(`⚠️ Erro ao remover pipe: ${error.message}`);
        }
      }
      
      this.activeProcesses.delete(processId);
      return true;
    }
    
    return false;
  }

  /**
   * Parar todos os processos
   */
  stopAllProcesses() {
    this.logger.info('🛑 Parando todos os processos...');
    
    const processIds = Array.from(this.activeProcesses.keys());
    processIds.forEach(id => this.stopProcess(id));
    
    this.activeProcesses.clear();
    this.logger.info('✅ Todos os processos parados');
  }

  /**
   * Obter estatísticas de todos os processos
   */
  getStats() {
    const stats = [];
    
    for (const [id, process] of this.activeProcesses) {
      stats.push({
        processId: id,
        pipePath: process.pipePath,
        uptime: Date.now() - process.startTime,
        pipeReader: process.pipeReader ? process.pipeReader.getStats() : null,
        streamlinkPid: process.streamlink?.pid || null,
        streamlinkAlive: process.streamlink && !process.streamlink.killed
      });
    }
    
    return stats;
  }

  /**
   * Obter qualidades disponíveis (mantido para compatibilidade)
   */
  async getAvailableQualities(streamUrl, referer = null) {
    const args = [streamUrl, '--json'];
    
    if (referer) {
      args.splice(1, 0, '--http-header', `Referer=${referer}`);
    }

    return new Promise((resolve, reject) => {
      const process = spawn('streamlink', args);
      let output = '';

      process.stdout.on('data', (data) => {
        output += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          try {
            const streamInfo = JSON.parse(output);
            resolve(Object.keys(streamInfo.streams || {}));
          } catch (error) {
            reject(new Error('Erro ao parsear informações do stream'));
          }
        } else {
          reject(new Error(`Streamlink falhou com código ${code}`));
        }
      });

      process.on('error', reject);
    });
  }
}
