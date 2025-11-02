import { spawn } from 'child_process';
import Logger from '../utils/Logger.js';

export default class StreamlinkManager {
  constructor() {
    this.logger = new Logger('StreamlinkManager');
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
      timeout = 300
    } = options;

    const args = [
      '--loglevel', 'info',
      '--output', outputPath,
      '--force',
      '--retry-streams', retryStreams.toString(),
      '--retry-max', retryMax.toString()
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
      const process = spawn('streamlink', args);
      let isStable = false;
      const startTime = Date.now();

      process.stdout.on('data', (data) => {
        const output = data.toString().trim();
        if (output && !output.includes('segment')) {
          this.logger.debug(`STREAMLINK: ${output}`);
          if (output.includes('Writing output') || output.includes('Opening output')) {
            isStable = true;
          }
        }
      });

      process.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('[cli][info]')) {
          this.logger.info(`STREAMLINK INFO: ${output.trim()}`);
          if (output.includes('Opening output')) {
            isStable = true;
          }
        }
        if (output.includes('error') && !output.includes('segment')) {
          this.logger.warn(`STREAMLINK WARN: ${output.trim()}`);
        }
      });

      process.on('close', (code) => {
        const duration = Math.round((Date.now() - startTime) / 1000);
        this.logger.info(`Streamlink terminou com código ${code} após ${duration}s`);
        resolve(isStable && code === 0);
      });

      process.on('error', (error) => {
        this.logger.error('Erro no processo Streamlink:', error);
        reject(error);
      });

      // Timeout
      setTimeout(() => {
        process.kill('SIGTERM');
        this.logger.warn('Streamlink timeout');
      }, timeout * 1000);
    });
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
}
