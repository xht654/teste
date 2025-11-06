import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import Logger from '../utils/Logger.js';

export default class StreamlinkManager {
  constructor() {
    this.logger = new Logger('StreamlinkManager');
    this.activeProcesses = new Map();
  }

  // NOVA ABORDAGEM: Streamlink escreve diretamente em arquivo TS
  // Depois criamos um loop que lê arquivo e escreve na pipe
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
      // SIMPLIFICAÇÃO: Usar arquivo .ts diretamente, não criar pipe
      const tempFile = outputPath.replace('.pipe', '.ts');
      
      // NÃO criar pipe - vamos usar o arquivo .ts via HTTP
      // await this.createPipe(outputPath);

      // Argumentos Streamlink - escrever em arquivo
      const streamlinkArgs = [
        '--loglevel', 'info',
        '--output', tempFile, // Escrever em arquivo
        '--force',
        '--retry-streams', retryStreams.toString(),
        '--retry-max', retryMax.toString(),
        '--stream-segment-timeout', '60.0',
        '--hls-live-restart',
        '--stream-types', 'hls' // Forçar HLS simples
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

      const streamlinkCmd = `streamlink ${streamlinkArgs.join(' ')}`;
      this.logger.info(`Comando Streamlink: ${streamlinkCmd}`);
      this.logger.info(`Arquivo de saída: ${tempFile}`);
      this.logger.info(`🌐 Disponível via HTTP: /files/${path.basename(tempFile)}`);

      return new Promise((resolve, reject) => {
        // Iniciar Streamlink
        this.logger.debug('Iniciando Streamlink...');
        const streamlinkProcess = spawn('streamlink', streamlinkArgs, {
          stdio: ['ignore', 'pipe', 'pipe']
        });

        streamlinkProcess.on('spawn', () => {
          this.logger.info('✅ Streamlink iniciado (PID: ' + streamlinkProcess.pid + ')');
        });

        const processId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.activeProcesses.set(processId, { streamlink: streamlinkProcess });

        let isStable = false;
        let hasError = false;
        const startTime = Date.now();

        // REMOVIDO: Leitor arquivo->pipe
        // Agora usamos arquivo .ts diretamente via HTTP

        // Aguardar arquivo ser criado e verificar se cresce
        const waitForFile = setInterval(() => {
          if (fs.existsSync(tempFile)) {
            const stats = fs.statSync(tempFile);
            if (stats.size > 0 && !isStable) {
              isStable = true;
              clearInterval(waitForFile);
              this.logger.info(`✅ Arquivo .ts criado e com dados (${stats.size} bytes)`);
            }
          }
        }, 500);

        // Logs Streamlink
        streamlinkProcess.stderr.on('data', (data) => {
          const output = data.toString();
          
          if (output.trim()) {
            this.logger.debug(`STREAMLINK: ${output.trim()}`);
          }
          
          if (output.includes('[cli][info]')) {
            const cleanOutput = output.replace('[cli][info]', '').trim();
            if (cleanOutput && !cleanOutput.includes('segment')) {
              this.logger.info(`STREAMLINK: ${cleanOutput}`);
            }
          }
          
          if (output.includes('error:') || output.includes('Failed to')) {
            this.logger.error(`STREAMLINK ERROR: ${output.trim()}`);
            hasError = true;
          }
        });

        // Handle exit
        streamlinkProcess.on('close', (code) => {
          const duration = Math.round((Date.now() - startTime) / 1000);
          this.logger.info(`Streamlink terminou com código ${code} após ${duration}s`);
          
          clearInterval(waitForFile);

          // NÃO remover arquivo .ts - será usado via HTTP
          this.logger.info(`📁 Arquivo mantido: ${tempFile}`);
          
          // Cleanup
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
          clearInterval(waitForFile);
          this.activeProcesses.delete(processId);
          reject(error);
        });

        // Timeout
        const timeoutHandle = setTimeout(() => {
          if (!streamlinkProcess.killed) {
            this.logger.warn(`Timeout após ${timeout}s`);
            streamlinkProcess.kill('SIGTERM');
            setTimeout(() => {
              if (!streamlinkProcess.killed) streamlinkProcess.kill('SIGKILL');
            }, 5000);
          }
        }, timeout * 1000);

        streamlinkProcess.on('close', () => {
          clearTimeout(timeoutHandle);
          clearInterval(waitForFile);
        });
      });

    } catch (error) {
      this.logger.error('Erro ao iniciar streaming:', error);
      throw error;
    }
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

  // Parar todos os processos
  stopAllProcesses() {
    this.logger.info('Parando todos os processos...');
    for (const [id, processes] of this.activeProcesses) {
      if (processes.streamlink && !processes.streamlink.killed) {
        processes.streamlink.kill('SIGTERM');
      }
    }
    this.activeProcesses.clear();
  }

  // Outros métodos permanecem iguais...
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

  stopProcess(processId) {
    const processes = this.activeProcesses.get(processId);
    if (processes && processes.streamlink && !processes.streamlink.killed) {
      processes.streamlink.kill('SIGTERM');
      this.activeProcesses.delete(processId);
      return true;
    }
    return false;
  }
}
