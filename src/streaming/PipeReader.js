import { EventEmitter } from 'events';
import fs from 'fs';
import Logger from '../utils/Logger.js';

export default class PipeReader extends EventEmitter {
  constructor(pipePath, options = {}) {
    super();
    this.pipePath = pipePath;
    this.logger = new Logger('PipeReader');
    
    // Configurações
    this.bufferDuration = options.bufferDuration || 60; // segundos
    this.maxBufferSize = options.maxBufferSize || 10 * 1024 * 1024; // 10MB padrão
    
    // Estado
    this.isReading = false;
    this.circularBuffer = [];
    this.totalBytesRead = 0;
    this.startTime = null;
    this.readStream = null;
    this.clients = new Set();
    
    // Estatísticas
    this.stats = {
      bytesRead: 0,
      chunksRead: 0,
      bufferSize: 0,
      clients: 0,
      uptime: 0
    };
  }

  /**
   * Inicia leitura da pipe
   */
  async start() {
    if (this.isReading) {
      this.logger.warn('PipeReader já está em execução');
      return;
    }

    try {
      // Verificar se pipe existe
      if (!fs.existsSync(this.pipePath)) {
        throw new Error(`Pipe não existe: ${this.pipePath}`);
      }

      // Verificar se é realmente uma pipe
      const stats = fs.statSync(this.pipePath);
      if (!stats.isFIFO()) {
        throw new Error(`${this.pipePath} não é uma named pipe (FIFO)`);
      }

      this.logger.info(`🚀 Iniciando leitura da pipe: ${this.pipePath}`);
      this.startTime = Date.now();
      this.isReading = true;

      // Criar stream de leitura
      this.readStream = fs.createReadStream(this.pipePath, {
        highWaterMark: 64 * 1024 // 64KB chunks
      });

      // Event: Dados recebidos
      this.readStream.on('data', (chunk) => {
        this.handleChunk(chunk);
      });

      // Event: Erro
      this.readStream.on('error', (error) => {
        this.logger.error(`Erro na leitura da pipe: ${error.message}`);
        this.emit('error', error);
        this.stop();
      });

      // Event: Fim do stream
      this.readStream.on('end', () => {
        this.logger.info('Stream da pipe encerrado');
        this.emit('end');
        this.stop();
      });

      // Event: Pipe aberta
      this.readStream.on('open', () => {
        this.logger.info('✅ Pipe aberta com sucesso para leitura');
        this.emit('ready');
      });

      // Iniciar timer de estatísticas
      this.startStatsTimer();

      return true;

    } catch (error) {
      this.logger.error(`Erro ao iniciar PipeReader: ${error.message}`);
      this.isReading = false;
      throw error;
    }
  }

  /**
   * Processa chunk recebido da pipe
   */
  handleChunk(chunk) {
    this.totalBytesRead += chunk.length;
    this.stats.bytesRead += chunk.length;
    this.stats.chunksRead++;

    // Adicionar ao buffer circular
    this.circularBuffer.push({
      data: chunk,
      timestamp: Date.now(),
      size: chunk.length
    });

    // Calcular tamanho total do buffer
    const currentBufferSize = this.circularBuffer.reduce((sum, item) => sum + item.size, 0);
    this.stats.bufferSize = currentBufferSize;

    // Remover chunks antigos se buffer muito grande
    while (currentBufferSize > this.maxBufferSize && this.circularBuffer.length > 1) {
      const removed = this.circularBuffer.shift();
      this.logger.debug(`Buffer cheio, removendo chunk antigo (${removed.size} bytes)`);
    }

    // Emitir chunk para clientes conectados
    this.emit('data', chunk);
    this.broadcastToClients(chunk);

    // Log periódico (a cada 100 chunks)
    if (this.stats.chunksRead % 100 === 0) {
      this.logger.debug(`📊 Chunks lidos: ${this.stats.chunksRead} | Buffer: ${this.formatBytes(currentBufferSize)} | Clientes: ${this.clients.size}`);
    }
  }

  /**
   * Envia chunk para todos os clientes HTTP conectados
   */
  broadcastToClients(chunk) {
    if (this.clients.size === 0) return;

    const deadClients = [];

    for (const client of this.clients) {
      try {
        if (!client.destroyed && client.writable) {
          client.write(chunk);
        } else {
          deadClients.push(client);
        }
      } catch (error) {
        this.logger.debug(`Erro ao enviar para cliente: ${error.message}`);
        deadClients.push(client);
      }
    }

    // Remover clientes mortos
    deadClients.forEach(client => {
      this.removeClient(client);
    });
  }

  /**
   * Adiciona cliente HTTP
   */
  addClient(response) {
    this.clients.add(response);
    this.stats.clients = this.clients.size;

    this.logger.info(`✅ Novo cliente conectado (Total: ${this.clients.size})`);

    // Enviar buffer existente para novo cliente (catch-up)
    if (this.circularBuffer.length > 0) {
      this.logger.debug(`Enviando buffer inicial para novo cliente (${this.circularBuffer.length} chunks)`);
      
      for (const item of this.circularBuffer) {
        try {
          if (response.writable) {
            response.write(item.data);
          }
        } catch (error) {
          this.logger.warn(`Erro ao enviar buffer inicial: ${error.message}`);
          break;
        }
      }
    }

    // Monitorar desconexão do cliente
    response.on('close', () => {
      this.removeClient(response);
    });

    response.on('error', () => {
      this.removeClient(response);
    });
  }

  /**
   * Remove cliente HTTP
   */
  removeClient(response) {
    if (this.clients.has(response)) {
      this.clients.delete(response);
      this.stats.clients = this.clients.size;
      this.logger.info(`❌ Cliente desconectado (Total: ${this.clients.size})`);
    }
  }

  /**
   * Para leitura da pipe
   */
  stop() {
    if (!this.isReading) return;

    this.logger.info('⏹️ Parando PipeReader...');
    this.isReading = false;

    // Fechar stream
    if (this.readStream) {
      try {
        this.readStream.destroy();
      } catch (error) {
        this.logger.debug(`Erro ao fechar stream: ${error.message}`);
      }
      this.readStream = null;
    }

    // Desconectar todos os clientes
    for (const client of this.clients) {
      try {
        if (!client.destroyed) {
          client.end();
        }
      } catch (error) {
        this.logger.debug(`Erro ao fechar cliente: ${error.message}`);
      }
    }
    this.clients.clear();

    // Limpar buffer
    this.circularBuffer = [];

    // Parar timer de estatísticas
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    this.logger.info('✅ PipeReader parado');
    this.emit('stopped');
  }

  /**
   * Timer de estatísticas
   */
  startStatsTimer() {
    this.statsTimer = setInterval(() => {
      this.stats.uptime = this.startTime ? Date.now() - this.startTime : 0;
      
      // Log de estatísticas a cada 30 segundos
      this.logger.debug(`📊 Stats: ${this.formatBytes(this.stats.bytesRead)} lidos | Buffer: ${this.formatBytes(this.stats.bufferSize)} | Clientes: ${this.stats.clients} | Uptime: ${this.formatUptime(this.stats.uptime)}`);
    }, 30000); // 30 segundos
  }

  /**
   * Obtém estatísticas atuais
   */
  getStats() {
    return {
      ...this.stats,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      isReading: this.isReading,
      pipePath: this.pipePath,
      bufferChunks: this.circularBuffer.length
    };
  }

  /**
   * Obtém buffer atual (para novos clientes)
   */
  getBuffer() {
    return this.circularBuffer.map(item => item.data);
  }

  /**
   * Verifica se está ativo
   */
  isActive() {
    return this.isReading && this.readStream && !this.readStream.destroyed;
  }

  /**
   * Formata bytes para leitura humana
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Formata uptime
   */
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
