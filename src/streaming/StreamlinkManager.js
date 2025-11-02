import { spawn } from 'child_process';
import fs from 'fs';
import Logger from '../utils/Logger.js';

export default class StreamlinkManager {
  constructor() {
    this.logger = new Logger('StreamlinkManager');
    this.activeProcesses = new Map();
  }

  // Criar named pipe antes de executar Streamlink
  async createPipe(pipePath) {
    try {
      // Remover pipe existente
      if (fs.existsSync(pipePath)) {
        fs.unlinkSync(pipePath);
        this.logger.debug(`Pipe antiga removida: ${pipePath}`);
      }

      // Criar nova pipe usando mkfifo
      const { execSync } = await import('child_process');
      execSync(`mkfifo "${pipePath}"`);
      
      // Dar permissões adequadas
      fs.chmodSync(pipePath, 0o666);
      
      this.logger.info(`✅ Named pipe criada: ${pipePath}`);
      return true;
    } catch (error) {
      this.logger.error(`Erro ao criar pipe: ${error.message}`);
      throw error;
    }
  }

  // Executar Streamlink com referer e configurações avançadas
  async streamToOutput(streamUrl, outputPath, options = {}) {
    const {
      quality = 'best',
      referer = null,
      userAgent = null,
      retryStreams = 3,
      retryMax = 5,
      customArgs = '',
      timeout = 600 // AUMENTADO para 10 minutos
    } = options;

    try {
      // Criar pipe primeiro
      await this.createPipe(outputPath);

      const args = [
        '--loglevel', 'info',
        '--output', outputPath,
        '--force',
        '--retry-streams', retryStreams.toString(),
        '--retry-max', retryMax.toString(),
        '--stream-segment-timeout', '60.0', // ADICIONADO: timeout por segmento
        '--hls-live-restart', // ADICIONADO: restart automático
        '--hls-segment-stream-data' // ADICIONADO: melhor handling de dados
      ];

      // Adicionar referer se especificado
      if (referer) {
        args.push('--http-header', `Referer=${referer}`);
        this.logger.info(`Usando referer: ${referer}`);
      }

      // Adicionar User-Agent se especificado
      if (userAgent) {
        args.push('--http-header', `User-Agent=${userAgent}`);
      }

      // Adicionar argumentos personalizados
      if (customArgs && customArgs.trim()) {
        const customArgArray = customArgs.trim().split(/\s+/);
        args.push(...customArgArray);
        this.logger.info(`Argumentos personalizados: ${customArgs}`);
      }

      // Adicionar URL e qualidade
      args.push(streamUrl, quality);

      const command = `streamlink ${args.join(' ')}`;
      this.logger.info(`Comando Streamlink: ${command}`);

      return new Promise((resolve, reject) => {
        const streamProcess = spawn('streamlink', args, {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        
        const processId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.activeProcesses.set(processId, streamProcess);

        let isStable = false;
        let hasError = false;
        const startTime = Date.now();
        let outputReceived = false;

        streamProcess.stdout.on('data', (data) => {
          const output = data.toString().trim();
          if (output && !output.includes('segment')) {
            this.logger.debug(`STREAMLINK: ${output}`);
            if (output.includes('Writing output') || output.includes('Opening output')) {
              isStable = true;
              outputReceived = true;
            }
          }
        });

        streamProcess.stderr.on('data', (data) => {
          const output = data.toString();
          
          // Log apenas mensagens importantes
          if (output.includes('[cli][info]')) {
            this.logger.info(`STREAMLINK INFO: ${output.trim()}`);
            if (output.includes('Opening output') || output.includes('Stream')) {
              isStable = true;
              outputReceived = true;
            }
          }
          
          // Detectar erros críticos
          if (output.includes('error: ') || output.includes('Failed to')) {
            this.logger.error(`STREAMLINK ERROR: ${output.trim()}`);
            hasError = true;
          }
        });

        streamProcess.on('close', (code) => {
          const duration = Math.round((Date.now() - startTime) / 1000);
          this.activeProcesses.delete(processId);
          
          this.logger.info(`Streamlink terminou com código ${code} após ${duration}s`);
          
          // Código 0 = sucesso, Código 130 = SIGTERM (esperado no timeout)
          if (code === 0 || (isStable && code === 130)) {
            resolve(true);
          } else if (hasError || code === 1) {
            resolve(false);
          } else {
            // Outros códigos mas teve output
            resolve(outputReceived);
          }
        });

        streamProcess.on('error', (error) => {
          this.logger.error('Erro no processo Streamlink:', error);
          this.activeProcesses.delete(processId);
          reject(error);
        });

        // Timeout com cleanup
        const timeoutHandle = setTimeout(() => {
          if (streamProcess && !streamProcess.killed) {
            this.logger.warn(`Streamlink timeout após ${timeout}s`);
            
            // Tentar terminar gracefully primeiro
            streamProcess.kill('SIGTERM');
            
            // Force kill após 5s se necessário
            setTimeout(() => {
              if (!streamProcess.killed) {
                streamProcess.kill('SIGKILL');
              }
            }, 5000);
          }
        }, timeout * 1000);

        // Limpar timeout se processo terminar antes
        streamProcess.on('close', () => {
          clearTimeout(timeoutHandle);
        });
      });

    } catch (error) {
      this.logger.error('Erro ao iniciar Streamlink:', error);
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
    const process = this.activeProcesses.get(processId);
    if (process && !process.killed) {
      process.kill('SIGTERM');
      this.activeProcesses.delete(processId);
      return true;
    }
    return false;
  }

  // Parar todos os processos
  stopAllProcesses() {
    this.logger.info('Parando todos os processos Streamlink...');
    for (const [id, process] of this.activeProcesses) {
      if (!process.killed) {
        process.kill('SIGTERM');
      }
    }
    this.activeProcesses.clear();
  }
}
