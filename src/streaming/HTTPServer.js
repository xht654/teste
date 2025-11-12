// src/streaming/HTTPServer.js - COMPLETO COM PLAYER HLS
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import Logger from '../utils/Logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class HTTPServer {
  constructor(sessionManager, configManager) {
    this.sessionManager = sessionManager;
    this.configManager = configManager;
    this.logger = new Logger('HTTPServer');
    this.app = express();
    this.server = null;
    this.port = 8080;
    this.hlsDir = '/app/hls'; // Diretório dos arquivos HLS
  }

  async start() {
    this.setupMiddleware();
    this.setupRoutes();
    
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        this.logger.info(`🌐 Servidor HTTP HLS ativo na porta ${this.port}`);
        this.logger.info(`📡 HLS disponível em: http://stream-capture:${this.port}/hls/<site_id>/stream.m3u8`);
        this.logger.info(`🎬 Player disponível em: http://stream-capture:${this.port}/player/<site_id>`);
        resolve();
      });
      
      this.server.on('error', reject);
    });
  }

  async stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          this.logger.info('⏹️ Servidor HTTP parado');
          resolve();
        });
      });
    }
  }

  setupMiddleware() {
    this.app.use(express.json());
    
    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });

    // Log de requisições
    this.app.use((req, res, next) => {
      this.logger.debug(`📥 ${req.method} ${req.url} - ${req.ip}`);
      next();
    });
  }

  setupRoutes() {
    // ==========================================
    // 🎬 ROTAS DO PLAYER HLS
    // ==========================================
    
    // Player HTML (arquivo estático)
    this.app.get('/player', (req, res) => {
      const playerPath = path.join(__dirname, '../../web/player.html');
      res.sendFile(playerPath, (err) => {
        if (err) {
          this.logger.error('Erro ao servir player.html:', err);
          res.status(404).send(`
            <!DOCTYPE html>
            <html><head><title>Player não encontrado</title></head>
            <body style="font-family: Arial; padding: 50px; text-align: center;">
              <h1>❌ Player não encontrado</h1>
              <p>O arquivo web/player.html não existe.</p>
              <p>Crie o arquivo ou use o link direto do HLS.</p>
              <a href="/streams">Ver streams disponíveis</a>
            </body></html>
          `);
        }
      });
    });

    // Player específico por site (redireciona com parâmetros)
    this.app.get('/player/:siteId', (req, res) => {
      const { siteId } = req.params;
      const session = this.sessionManager.activeSessions.get(siteId);
      
      if (!session || !session.isRunning) {
        res.status(404).send(`
          <!DOCTYPE html>
          <html lang="pt">
          <head>
            <meta charset="UTF-8">
            <title>Site não encontrado</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
          </head>
          <body class="bg-dark text-white">
            <div class="container mt-5 text-center">
              <h1><i class="bi bi-exclamation-triangle"></i> Site não encontrado</h1>
              <p class="lead">O site "<strong>${siteId}</strong>" não está ativo no momento.</p>
              <hr>
              <h4>Streams Disponíveis:</h4>
              <div class="list-group mt-3">
                ${this.getActiveStreamsHTML()}
              </div>
              <a href="/streams" class="btn btn-primary mt-4">Ver JSON dos Streams</a>
            </div>
          </body>
          </html>
        `);
        return;
      }
      
      // Redirecionar para player com parâmetros
      const siteName = session.site?.name || siteId;
      res.redirect(`/player?site=${siteId}&url=/hls/${siteId}/stream.m3u8&name=${encodeURIComponent(siteName)}`);
    });

    // ==========================================
    // 📁 SERVIR ARQUIVOS HLS ESTÁTICOS
    // ==========================================
    this.app.use('/hls', express.static(this.hlsDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.m3u8')) {
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        } else if (filePath.endsWith('.ts')) {
          res.setHeader('Content-Type', 'video/mp2t');
          res.setHeader('Cache-Control', 'public, max-age=60');
        }
      }
    }));

    // ==========================================
    // 📊 ROTAS DE STATUS E INFO
    // ==========================================
    
    // Status de um stream específico
    this.app.get('/:siteId/status', (req, res) => {
      const { siteId } = req.params;
      const session = this.sessionManager.activeSessions.get(siteId);
      
      if (!session) {
        res.status(404).json({ 
          error: 'Sessão não encontrada',
          siteId 
        });
        return;
      }
      
      const baseUrl = this.getBaseUrl(req);
      
      res.json({
        siteId,
        siteName: session.site.name,
        isRunning: session.isRunning,
        status: session.status,
        uptime: session.startTime ? Date.now() - session.startTime : 0,
        restartCount: session.restartCount,
        
        // URLs
        hlsPlaylist: `${baseUrl}/hls/${siteId}/stream.m3u8`,
        hlsPlayer: `${baseUrl}/player/${siteId}`,
        hlsDir: `/hls/${siteId}/`,
        
        // Stats
        ffmpegStats: session.ffmpegStats || null,
        hlsInfo: session.hlsInfo || null,
        
        // Stream info
        currentStream: session.currentStream || null,
        pipePath: session.currentPipePath || null
      });
    });

    // Status global do servidor
    this.app.get('/status', (req, res) => {
      const baseUrl = this.getBaseUrl(req);
      const sessions = this.sessionManager.getSessionsStatus();
      const activeSessions = Object.values(sessions).filter(s => s.isRunning);
      
      const streamDetails = {};
      for (const [siteId, session] of this.sessionManager.activeSessions) {
        if (session.isRunning && session.hlsInfo) {
          streamDetails[siteId] = {
            name: session.site.name,
            hlsPlaylist: `${baseUrl}/hls/${siteId}/stream.m3u8`,
            hlsPlayer: `${baseUrl}/player/${siteId}`,
            hlsDir: `/hls/${siteId}/`,
            stats: session.ffmpegStats || {},
            status: session.status,
            uptime: session.startTime ? Date.now() - session.startTime : 0
          };
        }
      }
      
      res.json({
        server: 'HTTP HLS Stream Server',
        version: '2.0-HLS',
        port: this.port,
        totalSessions: Object.keys(sessions).length,
        activeSessions: activeSessions.length,
        streams: streamDetails,
        endpoints: {
          player: '/player (HTML Player)',
          playerSite: '/player/:siteId (Player específico)',
          hls: '/hls/:siteId/stream.m3u8 (HLS Playlist)',
          status: '/status (Status geral)',
          siteStatus: '/:siteId/status (Status do site)',
          streams: '/streams (Lista de streams)',
          playlist: '/playlist.m3u (M3U para IPTV)',
          health: '/health (Health check)'
        },
        timestamp: new Date().toISOString()
      });
    });

    // Lista todos os streams ativos
    this.app.get('/streams', (req, res) => {
      const baseUrl = this.getBaseUrl(req);
      const sessions = this.sessionManager.getSessionsStatus();
      const streams = {};
      
      for (const [siteId, session] of Object.entries(sessions)) {
        if (session.isRunning && session.hlsInfo) {
          streams[siteId] = {
            name: session.siteName,
            hlsPlaylist: `${baseUrl}/hls/${siteId}/stream.m3u8`,
            hlsPlayer: `${baseUrl}/player/${siteId}`,
            status: session.status,
            uptime: session.uptime,
            segmentCount: session.ffmpegStats?.segmentCount || 0,
            quality: session.currentStream?.quality || 'auto'
          };
        }
      }
      
      res.json({
        total: Object.keys(streams).length,
        streams
      });
    });

    // Playlist M3U para TVHeadend/IPTV
    this.app.get('/playlist.m3u', (req, res) => {
      const baseUrl = this.getBaseUrl(req);
      const sessions = this.sessionManager.getSessionsStatus();
      
      let m3uContent = '#EXTM3U\n';
      m3uContent += '#EXTINF:-1,Stream Capture - Todos os Canais\n';
      
      for (const [siteId, session] of Object.entries(sessions)) {
        if (session.isRunning && session.hlsInfo) {
          m3uContent += `\n#EXTINF:-1 tvg-id="${siteId}" tvg-name="${session.siteName}" tvg-logo="" group-title="Live Streams",${session.siteName}\n`;
          m3uContent += `${baseUrl}/hls/${siteId}/stream.m3u8\n`;
        }
      }
      
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Content-Disposition', 'attachment; filename="stream-capture.m3u"');
      res.send(m3uContent);
    });

    // Health check
    this.app.get('/health', (req, res) => {
      const sessions = this.sessionManager.getSessionsStatus();
      const activeCount = Object.values(sessions).filter(s => s.isRunning).length;
      
      res.json({
        status: 'ok',
        active: activeCount > 0,
        activeStreams: activeCount,
        timestamp: new Date().toISOString()
      });
    });

    // ==========================================
    // 🏠 ROOT - Página de Boas-vindas
    // ==========================================
    this.app.get('/', (req, res) => {
      const baseUrl = this.getBaseUrl(req);
      const sessions = this.sessionManager.getSessionsStatus();
      const activeStreams = Object.entries(sessions).filter(([_, s]) => s.isRunning);
      
      res.send(`
        <!DOCTYPE html>
        <html lang="pt">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Stream Capture HLS Server</title>
          <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
          <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
          <style>
            body { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 30px; }
            .card { border: none; border-radius: 15px; box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
            .card-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border-radius: 15px 15px 0 0 !important; }
            .stream-item { padding: 15px; border-bottom: 1px solid #eee; transition: all 0.3s; }
            .stream-item:hover { background: #f8f9fa; transform: translateX(5px); }
            .stream-item:last-child { border-bottom: none; }
            .badge { padding: 8px 12px; }
            .btn-play { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border: none; }
            .btn-play:hover { transform: scale(1.05); }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="card">
              <div class="card-header text-center py-4">
                <h1 class="mb-0"><i class="fas fa-play-circle"></i> Stream Capture HLS Server</h1>
                <p class="mb-0 mt-2">Sistema de Streaming Multi-Sessão v2.0</p>
              </div>
              <div class="card-body">
                <h4 class="mb-4"><i class="fas fa-broadcast-tower"></i> Streams Ativos</h4>
                
                ${activeStreams.length > 0 ? `
                  <div class="streams-list">
                    ${activeStreams.map(([siteId, session]) => `
                      <div class="stream-item">
                        <div class="d-flex justify-content-between align-items-center">
                          <div>
                            <h5 class="mb-1">${session.siteName || siteId}</h5>
                            <small class="text-muted">
                              <i class="fas fa-circle text-success"></i> ${session.status}
                              <span class="ms-3"><i class="fas fa-clock"></i> ${this.formatUptime(session.uptime)}</span>
                            </small>
                          </div>
                          <div>
                            <a href="${baseUrl}/player/${siteId}" class="btn btn-play text-white me-2" target="_blank">
                              <i class="fas fa-play"></i> Player
                            </a>
                            <a href="${baseUrl}/hls/${siteId}/stream.m3u8" class="btn btn-outline-primary btn-sm" target="_blank">
                              <i class="fas fa-link"></i> M3U8
                            </a>
                          </div>
                        </div>
                      </div>
                    `).join('')}
                  </div>
                ` : `
                  <div class="alert alert-info text-center">
                    <i class="fas fa-info-circle fa-2x mb-3"></i>
                    <p class="mb-0">Nenhum stream ativo no momento.</p>
                    <small>Inicie streams através da interface de administração.</small>
                  </div>
                `}
                
                <hr class="my-4">
                
                <h5><i class="fas fa-link"></i> Links Úteis</h5>
                <div class="row mt-3">
                  <div class="col-md-6">
                    <ul class="list-group">
                      <li class="list-group-item">
                        <i class="fas fa-chart-bar text-primary"></i>
                        <a href="${baseUrl}/status" class="ms-2">Status JSON</a>
                      </li>
                      <li class="list-group-item">
                        <i class="fas fa-list text-success"></i>
                        <a href="${baseUrl}/streams" class="ms-2">Lista de Streams</a>
                      </li>
                      <li class="list-group-item">
                        <i class="fas fa-download text-warning"></i>
                        <a href="${baseUrl}/playlist.m3u">Playlist M3U</a>
                      </li>
                    </ul>
                  </div>
                  <div class="col-md-6">
                    <ul class="list-group">
                      <li class="list-group-item">
                        <i class="fas fa-heartbeat text-danger"></i>
                        <a href="${baseUrl}/health" class="ms-2">Health Check</a>
                      </li>
                      <li class="list-group-item">
                        <i class="fas fa-play-circle text-info"></i>
                        <a href="${baseUrl}/player" class="ms-2">Player HTML</a>
                      </li>
                      <li class="list-group-item">
                        <i class="fas fa-cog text-secondary"></i>
                        <a href="http://localhost:3001" target="_blank">Web Admin</a>
                      </li>
                    </ul>
                  </div>
                </div>
                
                <hr class="my-4">
                
                <h5><i class="fas fa-code"></i> Exemplos de Uso</h5>
                <div class="bg-dark text-white p-3 rounded">
                  <pre class="mb-0"><code># VLC Player
vlc ${baseUrl}/hls/&lt;site_id&gt;/stream.m3u8

# FFmpeg
ffmpeg -i ${baseUrl}/hls/&lt;site_id&gt;/stream.m3u8 -c copy output.mp4

# curl
curl ${baseUrl}/streams | jq</code></pre>
                </div>
              </div>
              <div class="card-footer text-center text-muted">
                <small>
                  <i class="fas fa-server"></i> Porta: ${this.port} | 
                  <i class="fas fa-clock"></i> ${new Date().toLocaleString('pt-PT')}
                </small>
              </div>
            </div>
          </div>
        </body>
        </html>
      `);
    });

    // ==========================================
    // ❌ 404 HANDLER
    // ==========================================
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Not Found',
        message: 'Endpoint não encontrado',
        path: req.path,
        availableEndpoints: [
          '/player (HTML Player)',
          '/player/:siteId (Player do site)',
          '/hls/:siteId/stream.m3u8 (HLS Playlist)',
          '/status (Status geral)',
          '/streams (Lista streams)',
          '/playlist.m3u (M3U)',
          '/health (Health check)'
        ]
      });
    });

    // ==========================================
    // ⚠️ ERROR HANDLER
    // ==========================================
    this.app.use((err, req, res, next) => {
      this.logger.error(`❌ Erro no servidor HTTP: ${err.message}`);
      res.status(500).json({
        error: 'Internal Server Error',
        message: err.message
      });
    });
  }

  // ==========================================
  // 🛠️ HELPER FUNCTIONS
  // ==========================================
  
  getBaseUrl(req) {
    const host = req.get('host') || `localhost:${this.port}`;
    const protocol = req.protocol || 'http';
    return `${protocol}://${host}`;
  }

  getActiveStreamsHTML() {
    const sessions = this.sessionManager.getSessionsStatus();
    const activeStreams = Object.entries(sessions).filter(([_, s]) => s.isRunning);
    
    if (activeStreams.length === 0) {
      return '<p class="text-muted text-center">Nenhum stream ativo</p>';
    }
    
    return activeStreams.map(([siteId, session]) => `
      <a href="/player/${siteId}" class="list-group-item list-group-item-action">
        <div class="d-flex w-100 justify-content-between">
          <h6 class="mb-1">${session.siteName || siteId}</h6>
          <small><i class="fas fa-circle text-success"></i> Ativo</small>
        </div>
        <small class="text-muted">${siteId}</small>
      </a>
    `).join('');
  }

  formatUptime(ms) {
    if (!ms || ms < 0) return '00:00:00';
    
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
}
