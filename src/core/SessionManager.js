// src/core/SessionManager.js - COMPLETO COM EVENTOS WEBSOCKET
import EventEmitter from 'events';
import CaptureSession from '../sites/CaptureSession.js';
import Logger from '../utils/Logger.js';

export default class SessionManager extends EventEmitter {
  constructor(configManager) {
    super();
    this.configManager = configManager;
    this.activeSessions = new Map();
    this.maxParallel = 3;
    this.logger = new Logger('SessionManager');
  }

  // Iniciar captura de múltiplos sites
  async startParallelCapture(siteIds = []) {
    const config = this.configManager.config;
    const sites = siteIds.length > 0 
      ? siteIds.map(id => ({ id, ...config.sites[id] }))
      : Object.entries(config.sites)
          .filter(([id, site]) => site.enabled)
          .map(([id, site]) => ({ id, ...site }));

    if (sites.length === 0) {
      throw new Error('Nenhum site habilitado para captura');
    }

    const promises = sites.slice(0, this.maxParallel).map(site => 
      this.startSiteCapture(site)
    );

    const results = await Promise.allSettled(promises);
    return this.processResults(results, sites);
  }

  // Iniciar captura de um site específico
  async startSiteCapture(site) {
    if (this.activeSessions.has(site.id)) {
      this.logger.warn(`Sessão já ativa para ${site.id}`);
      return this.activeSessions.get(site.id);
    }

    const session = new CaptureSession(site, this.configManager);
    this.activeSessions.set(site.id, session);

    // ==========================================
    // ✅ EVENT LISTENERS - REPASSAR PARA WEBSOCKET
    // ==========================================
    
    // Stream encontrado
    session.on('streamFound', (streamData) => {
      this.logger.info(`📡 Stream encontrado para ${site.id}`);
      this.emit('streamFound', { 
        siteId: site.id, 
        streamData,
        timestamp: Date.now()
      });
    });

    // Erro na sessão
    session.on('error', (error) => {
      this.logger.error(`Erro na sessão ${site.id}:`, error);
      this.emit('sessionError', { 
        siteId: site.id, 
        error: error.message,
        timestamp: Date.now()
      });
      // Não remover ainda - pode estar reiniciando
    });

    // Sessão encerrada
    session.on('ended', () => {
      this.logger.info(`Sessão ${site.id} encerrada`);
      this.emit('sessionEnded', { 
        siteId: site.id,
        timestamp: Date.now()
      });
      this.activeSessions.delete(site.id);
    });

    // ✅ NOVO: Sessão reiniciada
    session.on('restarted', (data) => {
      this.logger.info(`🔄 Sessão ${site.id} reiniciada (tentativa ${data.restartCount})`);
      this.emit('sessionRestarted', {
        siteId: site.id,
        restartCount: data.restartCount,
        timestamp: data.timestamp
      });
    });

    // ✅ NOVO: Mudança de status
    session.on('statusChanged', (data) => {
      this.logger.debug(`Status ${site.id}: ${data.status}`);
      this.emit('statusUpdate', { 
        siteId: site.id, 
        status: data.status,
        isRunning: data.isRunning,
        uptime: data.uptime,
        restartCount: data.restartCount,
        timestamp: Date.now()
      });
    });

    try {
      await session.start();
      
      // Emitir evento de início
      this.emit('sessionStarted', {
        siteId: site.id,
        siteName: site.name,
        timestamp: Date.now()
      });
      
      return session;
    } catch (error) {
      this.activeSessions.delete(site.id);
      throw error;
    }
  }

  // Parar uma sessão específica
  async stopSession(siteId) {
    const session = this.activeSessions.get(siteId);
    if (session) {
      await session.stop();
      this.activeSessions.delete(siteId);
      this.logger.info(`Sessão ${siteId} parada`);
      
      // Emitir evento
      this.emit('sessionEnded', { 
        siteId,
        timestamp: Date.now()
      });
    }
  }

  // Parar todas as sessões
  async stopAllSessions() {
    const promises = Array.from(this.activeSessions.keys()).map(siteId => 
      this.stopSession(siteId)
    );
    await Promise.all(promises);
  }

  // Reiniciar sessão específica
  async restartSession(siteId) {
    const session = this.activeSessions.get(siteId);
    if (session) {
      this.logger.info(`🔄 Reiniciando sessão ${siteId} manualmente`);
      await session.restart();
    } else {
      throw new Error(`Sessão ${siteId} não encontrada`);
    }
  }

  // Obter status de todas as sessões
  getSessionsStatus() {
    const status = {};
    for (const [siteId, session] of this.activeSessions) {
      status[siteId] = session.getStatus();
    }
    return status;
  }

  // Obter status de uma sessão específica
  getSessionStatus(siteId) {
    const session = this.activeSessions.get(siteId);
    return session ? session.getStatus() : null;
  }

  // Verificar se sessão está ativa
  isSessionActive(siteId) {
    return this.activeSessions.has(siteId);
  }

  // Obter número de sessões ativas
  getActiveSessionsCount() {
    return this.activeSessions.size;
  }

  processResults(results, sites) {
    const successful = [];
    const failed = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successful.push({ site: sites[index], session: result.value });
      } else {
        failed.push({ site: sites[index], error: result.reason });
      }
    });

    return { successful, failed };
  }
}
