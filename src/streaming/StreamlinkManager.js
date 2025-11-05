import { spawn } from 'child_process';
import fs from 'fs';
import Logger from '../utils/Logger.js';

export default class StreamlinkManager {
  constructor() {
    this.logger = new Logger('StreamlinkManager');
    this.activeProcesses = new Map();
  }

  // Criar named pipe
  async createPipe(pipePath) {
    try {
      if (fs.existsSync(pipePath)) {
        fs.unlinkSync(pipePath);
        this.logger.debug(`Pipe antiga removida: ${pipePath}`);
      }

      const { execSync } = await import('child_process');
      execSync(`mkfifo "${pipePath}"`);
      fs.chmodSync(pipePath, 0o666);
      
      this.logger.info(`✅ Named pipe criada: ${pipePath}`);
      return true;
    } catch (error) {
      this.logger.error(`Erro ao criar pipe: ${error.message}`);
      throw error;
    }
  }

  // NOVA ABORDAGEM: Streamlink -> FFmpeg -> Pipe
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
      // Criar pipe primeiro
      await this.createPipe(outputPath);

      // Argumentos Streamlink (output para stdout)
      const streamlinkArgs = [
        '--loglevel', 'info',
        '--stdout', // CRÍTICO: output para stdout ao invés de arquivo
        '--retry-streams', retryStreams.toString(),
        '--retry-max', retryMax.toString(),
        '--stream-segment-timeout', '60.0',
        //'--hls-live-restart', // Restart automático se stream parar
        //'--hls-segment-stream-data' // Forçar streaming direto de dados
      ];

      if (referer) {
        streamlinkArgs.push('--http-header', `Referer=${referer}`);
        this.logger.info(`Usando referer: ${referer}`);
      }

      if (userAgent) {
        streamlinkArgs.push('--http-header', `User-Agent=${userAgent}`);
      }

      if (customArgs && customArgs.trim()) {
        const customArgArray = customArgs.trim().split(/\s+/);
        streamlinkArgs.push(...customArgArray);
        this.logger.info(`Argumentos personalizados: ${customArgs}`);
      }

      streamlinkArgs.push(streamUrl, quality);

      // IMPORTANTE: Adicionar flag para desabilitar muxing
      const streamlinkArgsWithWorkaround = [
        ...streamlinkArgs.slice(0, -1), // Tudo exceto quality
        '--stream-types', 'hls', // Forçar HLS simples, não hls-multi
        quality
      ];

      const streamlinkCmd = `streamlink ${streamlinkArgs.join(' ')}`;
      this.logger.info(`Comando Streamlink: ${streamlinkCmd}`);

      // FFmpeg args (ler de stdin, escrever na pipe)
      const ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-i', 'pipe:0', // Ler de stdin
        '-c', 'copy', // Copy sem transcodificar
        '-f', 'mpegts', // Formato MPEG-TS
        '-y', // Overwrite
        outputPath
      ];

      this.logger.info(`FFmpeg irá escrever para: ${outputPath}`);

      return new Promise((resolve, reject) => {
        // Iniciar Streamlink
        this.logger.debug('Spawning Streamlink process...');
        const streamlinkProcess = spawn('streamlink', streamlinkArgs, {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        // Verificar se Streamlink iniciou
        streamlinkProcess.on('spawn', () => {
          this.logger.info('✅ Processo Streamlink iniciado (PID: ' + streamlinkProcess.pid + ')');
        });

        // Iniciar FFmpeg
        this.logger.debug('Spawning FFmpeg process...');
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        // Verificar se FFmpeg iniciou
        ffmpegProcess.on('spawn', () => {
          this.logger.info('✅ Processo FFmpeg iniciado (PID: ' + ffmpegProcess.pid + ')');
        });

        const processId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.activeProcesses.set(processId, { streamlink: streamlinkProcess, ffmpeg: ffmpegProcess });

        let isStable = false;
        let hasError = false;
        const startTime = Date.now();

        // Pipe Streamlink stdout -> FFmpeg stdin
        this.logger.info('🔗 Conectando Streamlink stdout -> FFmpeg stdin');
        streamlinkProcess.stdout.pipe(ffmpegProcess.stdin);

        // Logs Streamlink
        streamlinkProcess.stdout.on('data', (chunk) => {
          if (!isStable) {
            this.logger.info(`✅ Streamlink começou a enviar dados (${chunk.length} bytes)`);
            isStable = true;
          }
        });

        streamlinkProcess.stderr.on('data', (data) => {
          const output = data.toString();
          
          // Log TODAS as mensagens para debug
          if (output.trim()) {
            this.logger.debug(`STREAMLINK STDERR: ${output.trim()}`);
          }
          
          if (output.includes('[cli][info]')) {
            const cleanOutput = output.replace('[cli][info]', '').trim();
            if (cleanOutput && !cleanOutput.includes('segment')) {
              this.logger.info(`STREAMLINK: ${cleanOutput}`);
            }
            if (output.includes('Opening stream') || output.includes('Stream')) {
              isStable = true;
            }
          }
          
          if (output.includes('error:') || output.includes('Failed to')) {
            this.logger.error(`STREAMLINK ERROR: ${output.trim()}`);
            hasError = true;
          }
        });

        // Logs FFmpeg
        let ffmpegStarted = false;
        ffmpegProcess.stderr.on('data', (data) => {
          const output = data.toString();
          
          // Log TUDO do FFmpeg para debug
          if (output.trim()) {
            this.logger.debug(`FFMPEG STDERR: ${output.trim()}`);
          }
          
          if (!ffmpegStarted && (output.includes('Output') || output.includes('Stream') || output.includes('muxing'))) {
            this.logger.info('✅ FFmpeg começou a escrever na pipe');
            ffmpegStarted = true;
          }
          
          // Log erros do FFmpeg
          if (output.toLowerCase().includes('error') || output.toLowerCase().includes('failed')) {
            this.logger.error(`FFMPEG ERROR: ${output.trim()}`);
          }
        });

        // Log quando FFmpeg stdin recebe dados
        ffmpegProcess.stdin.on('pipe', () => {
          this.logger.info('✅ FFmpeg stdin conectado ao Streamlink stdout');
        });

        // Handle process exits
        streamlinkProcess.on('close', (code) => {
          const duration = Math.round((Date.now() - startTime) / 1000);
          this.logger.info(`Streamlink terminou com código ${code} após ${duration}s`);
          
          // Fechar stdin do FFmpeg quando Streamlink terminar
          try {
            ffmpegProcess.stdin.end();
          } catch (e) {}
        });

        ffmpegProcess.on('close', (code) => {
          const duration = Math.round((Date.now() - startTime) / 1000);
          this.logger.info(`FFmpeg terminou com código ${code} após ${duration}s`);
          
          this.activeProcesses.delete(processId);
          
          if (code === 0 || (isStable && code !== 1)) {
            resolve(true);
          } else if (hasError) {
            resolve(false);
          } else {
            resolve(isStable);
          }
        });

        // Error handling
        streamlinkProcess.on('error', (error) => {
          this.logger.error('❌ Erro ao iniciar Streamlink:', error);
          this.logger.error('Verifique se streamlink está instalado: pip3 list | grep streamlink');
          ffmpegProcess.kill('SIGTERM');
          this.activeProcesses.delete(processId);
          reject(error);
        });

        ffmpegProcess.on('error', (error) => {
          this.logger.error('❌ Erro ao iniciar FFmpeg:', error);
          this.logger.error('Verifique se ffmpeg está instalado: ffmpeg -version');
          streamlinkProcess.kill('SIGTERM');
          this.activeProcesses.delete(processId);
          reject(error);
        });

        // Timeout
        const timeoutHandle = setTimeout(() => {
          if (!streamlinkProcess.killed || !ffmpegProcess.killed) {
            this.logger.warn(`Timeout após ${timeout}s`);
            
            streamlinkProcess.kill('SIGTERM');
            ffmpegProcess.kill('SIGTERM');
            
            setTimeout(() => {
              if (!streamlinkProcess.killed) streamlinkProcess.kill('SIGKILL');
              if (!ffmpegProcess.killed) ffmpegProcess.kill('SIGKILL');
            }, 5000);
          }
        }, timeout * 1000);

        streamlinkProcess.on('close', () => clearTimeout(timeoutHandle));
        ffmpegProcess.on('close', () => clearTimeout(timeoutHandle));
      });

    } catch (error) {
      this.logger.error('Erro ao iniciar streaming:', error);
      throw error;
    }
  }

  // Listar qualidades disponíveis
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

  // Parar processo específico
  stopProcess(processId) {
    const processes = this.activeProcesses.get(processId);
    if (processes) {
      if (processes.streamlink && !processes.streamlink.killed) {
        processes.streamlink.kill('SIGTERM');
      }
      if (processes.ffmpeg && !processes.ffmpeg.killed) {
        processes.ffmpeg.kill('SIGTERM');
      }
      this.activeProcesses.delete(processId);
      return true;
    }
    return false;
  }

  // Parar todos os processos
  stopAllProcesses() {
    this.logger.info('Parando todos os processos...');
    for (const [id, processes] of this.activeProcesses) {
      if (processes.streamlink && !processes.streamlink.killed) {
        processes.streamlink.kill('SIGTERM');
      }
      if (processes.ffmpeg && !processes.ffmpeg.killed) {
        processes.ffmpeg.kill('SIGTERM');
      }
    }
    this.activeProcesses.clear();
  }
}
