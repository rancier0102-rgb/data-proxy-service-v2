const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración
const config = {
		PORT: process.env.PORT || 3000,
		ALLOWED_DOMAINS: process.env.ALLOWED_DOMAINS ? process.env.ALLOWED_DOMAINS.split(',') : [],
		DATA_FILE: process.env.DATA_FILE || 'data.json',
		CACHE_TTL: 5 * 60 * 1000
};

// Logger simple
const logger = {
		info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
		error: (msg, err) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, err?.message || '')
};

// Middleware de seguridad
app.use(compression());
app.use(helmet({
		contentSecurityPolicy: {
				directives: {
						defaultSrc: ["'self'"],
						styleSrc: ["'self'", "'unsafe-inline'"],
						scriptSrc: ["'self'", "'unsafe-inline'"],
						imgSrc: ["'self'", "data:", "https:", "http:"],
						mediaSrc: ["'self'", "blob:", "data:", "https:", "http:"],
						connectSrc: ["'self'", "https:", "http:"]
				}
		}
}));

// Rate limiting
const videoProxyLimiter = rateLimit({
		windowMs: 15 * 60 * 1000,
		max: 100,
		message: { status: 'error', message: 'Demasiadas solicitudes' }
});

// Variables globales
let SERIES_LIST = [];
let SERIES_INDEX = {};
let TOTAL_EPISODES = 0;
let DATA_LOADED = false;

// Cargar datos
function loadData() {
		try {
				const jsonPath = path.join(__dirname, config.DATA_FILE);
				console.log('📂 Buscando archivo en:', jsonPath);

				if (!fs.existsSync(jsonPath)) {
						console.error('❌ NO EXISTE el archivo data.json en:', jsonPath);
						return;
				}

				console.log('✅ Archivo encontrado. Leyendo...');
				const raw = fs.readFileSync(jsonPath, 'utf8');
				console.log('📄 Tamaño del archivo:', raw.length, 'bytes');

				const data = JSON.parse(raw);
				console.log('✅ JSON parseado. Tipo de dato:', Array.isArray(data) ? 'Array' : typeof data);

				if (!Array.isArray(data)) {
						throw new Error('data.json debe ser un array');
				}

				console.log('📊 Número de episodios en el archivo:', data.length);

				TOTAL_EPISODES = data.length;
				logger.info(`${TOTAL_EPISODES} episodios encontrados`);

				const map = {};
				data.forEach(item => {
						const name = item.series || 'Sin nombre';
						const season = String(item.season || '1');

						if (!map[name]) {
								map[name] = {
										name,
										poster: item["logo serie"] || '',
										seasons: {},
										count: 0
								};
						}

						if (!map[name].seasons[season]) {
								map[name].seasons[season] = [];
						}

						map[name].seasons[season].push({
								ep: item.ep || 1,
								title: item.title || `Episodio ${item.ep || 1}`,
								url: item.url || ''
						});
						map[name].count++;
				});

				// Ordenar episodios
				Object.values(map).forEach(series => {
						Object.keys(series.seasons).forEach(season => {
								series.seasons[season].sort((a, b) => a.ep - b.ep);
						});
				});

				SERIES_INDEX = map;
				SERIES_LIST = Object.values(map)
						.map(s => ({
								name: s.name,
								poster: s.poster,
								seasons: Object.keys(s.seasons).length,
								count: s.count
						}))
						.sort((a, b) => a.name.localeCompare(b.name));

				DATA_LOADED = true;
				logger.info(`${SERIES_LIST.length} series indexadas`);

		} catch (error) {
				console.error('❌ Error en loadData:', error.message);
				console.error(error.stack);
		}
}

// Cargar datos inicialmente
loadData();

// Middleware CORS
app.use((req, res, next) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		next();
});

// API Routes
app.get('/api/stats', (req, res) => {
		res.json({
				status: 'ok',
				series: SERIES_LIST.length,
				episodes: TOTAL_EPISODES,
				loaded: DATA_LOADED
		});
});

// Endpoint de debug
app.get('/api/debug', (req, res) => {
		const jsonPath = path.join(__dirname, config.DATA_FILE);
		if (!fs.existsSync(jsonPath)) {
				return res.json({ error: 'File not found', path: jsonPath });
		}
		const raw = fs.readFileSync(jsonPath, 'utf8');
		try {
				const data = JSON.parse(raw);
				res.json({
						path: jsonPath,
						fileExists: true,
						length: data.length,
						sample: data.slice(0, 2)
				});
		} catch (e) {
				res.json({ error: 'Invalid JSON', message: e.message });
		}
});

app.get('/api/series', (req, res) => {
		const page = parseInt(req.query.page) || 0;
		const limit = parseInt(req.query.limit) || 24;
		const search = (req.query.q || '').toLowerCase();

		let list = SERIES_LIST;
		if (search) {
				list = list.filter(s => s.name.toLowerCase().includes(search));
		}

		const total = list.length;
		const start = page * limit;

		res.json({
				status: 'ok',
				total,
				page,
				hasMore: start + limit < total,
				data: list.slice(start, start + limit)
		});
});

app.get('/api/series/:name', (req, res) => {
		const series = SERIES_INDEX[decodeURIComponent(req.params.name)];
		if (!series) {
				return res.status(404).json({ status: 'error', message: 'Serie no encontrada' });
		}
		res.json({ status: 'ok', data: series });
});

// Proxy de video
app.get('/video-proxy', videoProxyLimiter, (req, res) => {
		const url = req.query.url;
		if (!url) return res.status(400).end();

		try {
				const decodedUrl = decodeURIComponent(url);
				const parsed = new URL(decodedUrl);
				const client = parsed.protocol === 'https:' ? https : http;

				const opts = {
						hostname: parsed.hostname,
						port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
						path: parsed.pathname + parsed.search,
						headers: {
								'User-Agent': 'Mozilla/5.0',
								'Accept': '*/*',
								'Accept-Encoding': 'identity'
						}
				};

				if (req.headers.range) {
						opts.headers['Range'] = req.headers.range;
				}

				const proxyReq = client.request(opts, (proxyRes) => {
						if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
								return res.redirect(`/video-proxy?url=${encodeURIComponent(proxyRes.headers.location)}`);
						}

						res.status(proxyRes.statusCode);
						res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/mp4');
						res.setHeader('Accept-Ranges', 'bytes');

						if (proxyRes.headers['content-length']) {
								res.setHeader('Content-Length', proxyRes.headers['content-length']);
						}
						if (proxyRes.headers['content-range']) {
								res.setHeader('Content-Range', proxyRes.headers['content-range']);
						}

						proxyRes.pipe(res);
				});

				proxyReq.on('error', (error) => {
						logger.error('Error en proxy:', error);
						res.status(502).end();
				});

				proxyReq.end();

		} catch (error) {
				logger.error('Error procesando URL:', error);
				res.status(400).end();
		}
});

// HTML completo
const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Stream Series</title>
		<style>
				* {
						margin: 0;
						padding: 0;
						box-sizing: border-box;
						-webkit-tap-highlight-color: transparent;
				}

				:root {
						--primary: #e50914;
						--background: #0a0a0a;
						--surface: #141414;
						--text: #ffffff;
						--text-secondary: #b3b3b3;
						--border: #2a2a2a;
				}

				body {
						font-family: -apple-system, BlinkMacSystemFont, sans-serif;
						background: var(--background);
						color: var(--text);
						min-height: 100vh;
				}

				#app {
						min-height: 100vh;
						display: flex;
						flex-direction: column;
				}

				.header {
						padding: 16px;
						background: var(--surface);
						border-bottom: 1px solid var(--border);
						display: flex;
						align-items: center;
						justify-content: space-between;
						flex-wrap: wrap;
						gap: 12px;
						position: sticky;
						top: 0;
						z-index: 100;
				}

				.logo {
						font-size: 20px;
						font-weight: bold;
						color: var(--primary);
				}

				#search {
						flex: 1;
						min-width: 200px;
						max-width: 400px;
						padding: 10px 16px;
						background: var(--background);
						border: 1px solid var(--border);
						border-radius: 20px;
						color: var(--text);
						font-size: 14px;
						outline: none;
				}

				#search:focus {
						border-color: var(--primary);
				}

				.stats {
						font-size: 12px;
						color: var(--text-secondary);
						white-space: nowrap;
				}

				.content {
						flex: 1;
						padding: 20px;
						overflow-y: auto;
				}

				.grid {
						display: grid;
						grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
						gap: 16px;
						padding-bottom: 20px;
				}

				@media (max-width: 768px) {
						.grid {
								grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
								gap: 12px;
						}
						.header {
								padding: 12px;
						}
				}

				@media (max-width: 480px) {
						.grid {
								grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
								gap: 10px;
						}
				}

				.card {
						background: var(--surface);
						border-radius: 8px;
						overflow: hidden;
						cursor: pointer;
						transition: transform 0.2s, box-shadow 0.2s;
				}

				.card:hover {
						transform: translateY(-4px);
						box-shadow: 0 8px 25px rgba(0,0,0,0.3);
				}

				.card-poster {
						width: 100%;
						height: 200px;
						object-fit: cover;
						display: block;
						background: var(--border);
				}

				.card-info {
						padding: 12px;
				}

				.card-title {
						font-size: 14px;
						font-weight: 600;
						margin-bottom: 4px;
						display: -webkit-box;
						-webkit-line-clamp: 2;
						-webkit-box-orient: vertical;
						overflow: hidden;
				}

				.card-meta {
						font-size: 11px;
						color: var(--text-secondary);
				}

				.detail {
						position: fixed;
						inset: 0;
						background: var(--background);
						z-index: 1000;
						display: none;
						flex-direction: column;
						overflow: hidden;
				}

				.detail.active {
						display: flex;
				}

				.detail-header {
						padding: 16px 20px;
						display: flex;
						justify-content: space-between;
						align-items: center;
						background: var(--surface);
						border-bottom: 1px solid var(--border);
				}

				.detail-title {
						font-size: 18px;
						font-weight: bold;
						flex: 1;
						margin: 0 16px;
						white-space: nowrap;
						overflow: hidden;
						text-overflow: ellipsis;
				}

				.btn-back, .btn-close {
						background: rgba(255,255,255,0.1);
						border: none;
						color: var(--text);
						width: 40px;
						height: 40px;
						border-radius: 50%;
						cursor: pointer;
						display: flex;
						align-items: center;
						justify-content: center;
						font-size: 18px;
						transition: background 0.2s;
				}

				.btn-back:hover, .btn-close:hover {
						background: rgba(255,255,255,0.2);
				}

				.seasons {
						padding: 16px 20px;
						display: flex;
						gap: 8px;
						overflow-x: auto;
						background: var(--surface);
						border-bottom: 1px solid var(--border);
				}

				.season-btn {
						padding: 8px 16px;
						background: var(--background);
						border: 1px solid var(--border);
						border-radius: 20px;
						color: var(--text-secondary);
						cursor: pointer;
						white-space: nowrap;
						transition: all 0.2s;
				}

				.season-btn:hover {
						border-color: var(--text-secondary);
				}

				.season-btn.active {
						background: var(--primary);
						border-color: var(--primary);
						color: white;
				}

				.episodes {
						flex: 1;
						overflow-y: auto;
						padding: 20px;
				}

				.episode {
						background: var(--surface);
						border-radius: 8px;
						padding: 16px;
						margin-bottom: 12px;
						cursor: pointer;
						display: flex;
						align-items: center;
						gap: 12px;
						transition: background 0.2s;
				}

				.episode:hover {
						background: var(--border);
				}

				.episode-number {
						background: var(--primary);
						color: white;
						min-width: 36px;
						height: 36px;
						border-radius: 50%;
						display: flex;
						align-items: center;
						justify-content: center;
						font-size: 13px;
						font-weight: bold;
				}

				.episode-info {
						flex: 1;
						min-width: 0;
				}

				.episode-title {
						font-size: 14px;
						font-weight: 600;
						margin-bottom: 4px;
						white-space: nowrap;
						overflow: hidden;
						text-overflow: ellipsis;
				}

				.episode-meta {
						font-size: 12px;
						color: var(--text-secondary);
				}

				.player {
						position: fixed;
						inset: 0;
						background: black;
						z-index: 2000;
						display: none;
						flex-direction: column;
				}

				.player.active {
						display: flex;
				}

				.player-header {
						padding: 16px 20px;
						display: flex;
						justify-content: space-between;
						align-items: center;
						background: linear-gradient(to bottom, rgba(0,0,0,0.9), transparent);
						position: absolute;
						top: 0;
						left: 0;
						right: 0;
						z-index: 10;
				}

				.player-title {
						color: white;
						font-size: 16px;
						flex: 1;
						margin-left: 16px;
				}

				.video-container {
						flex: 1;
						display: flex;
						align-items: center;
						justify-content: center;
						background: black;
				}

				video {
						width: 100%;
						height: 100%;
						max-height: 100vh;
				}

				.loading, .empty, .error {
						text-align: center;
						padding: 60px 20px;
						color: var(--text-secondary);
				}

				.error {
						color: var(--primary);
				}

				.loading::after {
						content: '';
						display: block;
						width: 30px;
						height: 30px;
						margin: 20px auto;
						border: 3px solid var(--border);
						border-top-color: var(--primary);
						border-radius: 50%;
						animation: spin 1s linear infinite;
				}

				@keyframes spin {
						to { transform: rotate(360deg); }
				}

				::-webkit-scrollbar {
						width: 8px;
						height: 8px;
				}

				::-webkit-scrollbar-track {
						background: var(--background);
				}

				::-webkit-scrollbar-thumb {
						background: var(--border);
						border-radius: 4px;
				}

				::-webkit-scrollbar-thumb:hover {
						background: var(--text-secondary);
				}
		</style>
</head>
<body>
		<div id="app">
				<div class="header">
						<div class="logo">STREAM+</div>
						<input type="search" id="search" placeholder="Buscar series...">
						<div class="stats" id="stats">Cargando...</div>
				</div>

				<div class="content" id="content">
						<div class="grid" id="grid">
								<div class="loading">Cargando series...</div>
						</div>
				</div>

				<div class="detail" id="detail">
						<div class="detail-header">
								<button class="btn-back" id="detail-back">←</button>
								<div class="detail-title" id="detail-title"></div>
								<button class="btn-close" id="detail-close">✕</button>
						</div>
						<div class="seasons" id="seasons"></div>
						<div class="episodes" id="episodes"></div>
				</div>

				<div class="player" id="player">
						<div class="player-header">
								<button class="btn-close" id="player-close">✕</button>
								<div class="player-title" id="player-title"></div>
						</div>
						<div class="video-container">
								<video id="video" controls playsinline></video>
						</div>
				</div>
		</div>

		<script>
				(function() {
						'use strict';

						// Estado
						const state = {
								series: [],
								page: 0,
								hasMore: true,
								loading: false,
								search: '',
								currentSeries: null,
								currentSeason: null
						};

						// Esperar a que el DOM esté listo
						function ready(fn) {
								if (document.readyState !== 'loading') {
										fn();
								} else {
										document.addEventListener('DOMContentLoaded', fn);
								}
						}

						// Utilidades
						function escapeHTML(str) {
								if (!str) return '';
								return String(str).replace(/[&<>"']/g, function(m) {
										return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];
								});
						}

						function debounce(func, wait) {
								let timeout;
								return function(...args) {
										clearTimeout(timeout);
										timeout = setTimeout(() => func.apply(this, args), wait);
								};
						}

						// API
						async function fetchJSON(url) {
								const res = await fetch(url);
								if (!res.ok) throw new Error('HTTP ' + res.status);
								return res.json();
						}

						// Inicializar
						ready(function() {
								console.log('🚀 Iniciando aplicación...');

								// Obtener elementos
								const grid = document.getElementById('grid');
								const content = document.getElementById('content');
								const search = document.getElementById('search');
								const stats = document.getElementById('stats');
								const detail = document.getElementById('detail');
								const detailBack = document.getElementById('detail-back');
								const detailClose = document.getElementById('detail-close');
								const detailTitle = document.getElementById('detail-title');
								const seasons = document.getElementById('seasons');
								const episodes = document.getElementById('episodes');
								const player = document.getElementById('player');
								const playerClose = document.getElementById('player-close');
								const playerTitle = document.getElementById('player-title');
								const video = document.getElementById('video');

								// Verificar elementos
								if (!grid || !content) {
										console.error('❌ Elementos esenciales no encontrados');
										return;
								}

								console.log('✅ Elementos encontrados');

								// Cargar stats
								fetchJSON('/api/stats')
										.then(function(data) {
												console.log('📊 Stats:', data);
												stats.textContent = data.series + ' series · ' + data.episodes.toLocaleString() + ' episodios';
										})
										.catch(function(err) {
												console.error('Error stats:', err);
												stats.textContent = 'Error cargando';
										});

								// Cargar series
								function loadSeries(append) {
										if (state.loading) return;
										if (!append && !state.hasMore) return;

										state.loading = true;

										if (!append) {
												grid.innerHTML = '<div class="loading">Cargando series...</div>';
												state.page = 0;
												state.hasMore = true;
												state.series = [];
										}

										var url = '/api/series?page=' + state.page + '&limit=24';
										if (state.search) {
												url += '&q=' + encodeURIComponent(state.search);
										}

										fetchJSON(url)
												.then(function(data) {
														console.log('📺 Series cargadas:', data.data.length);

														if (!append) {
																grid.innerHTML = '';
														}

														if (data.data.length === 0 && !append) {
																grid.innerHTML = '<div class="empty">No se encontraron series</div>';
																return;
														}

														data.data.forEach(function(serie) {
																var card = document.createElement('div');
																card.className = 'card';
																card.innerHTML = 
																		'<img class="card-poster" src="' + escapeHTML(serie.poster || '') + '" alt="' + escapeHTML(serie.name) + '" onerror="this.style.opacity=0.3">' +
																		'<div class="card-info">' +
																				'<div class="card-title">' + escapeHTML(serie.name) + '</div>' +
																				'<div class="card-meta">T' + serie.seasons + ' · ' + serie.count + ' eps</div>' +
																		'</div>';

																card.addEventListener('click', function() {
																		openDetail(serie.name);
																});

																grid.appendChild(card);
														});

														state.series = state.series.concat(data.data);
														state.page++;
														state.hasMore = data.hasMore;
												})
												.catch(function(err) {
														console.error('Error cargando series:', err);
														if (!append) {
																grid.innerHTML = '<div class="error">Error al cargar series</div>';
														}
												})
												.finally(function() {
														state.loading = false;
												});
								}

								// Abrir detalle
								function openDetail(name) {
										console.log('📂 Abriendo:', name);
										detailTitle.textContent = name;
										detail.classList.add('active');
										seasons.innerHTML = '<div class="loading">Cargando...</div>';
										episodes.innerHTML = '';

										fetchJSON('/api/series/' + encodeURIComponent(name))
												.then(function(response) {
														state.currentSeries = response.data;
														var seasonKeys = Object.keys(state.currentSeries.seasons).sort(function(a,b) { return a - b; });
														state.currentSeason = seasonKeys[0];

														// Renderizar temporadas
														seasons.innerHTML = '';
														seasonKeys.forEach(function(season) {
																var btn = document.createElement('button');
																btn.className = 'season-btn' + (season === state.currentSeason ? ' active' : '');
																btn.textContent = 'T' + season;
																btn.addEventListener('click', function() {
																		state.currentSeason = season;
																		seasons.querySelectorAll('.season-btn').forEach(function(b) {
																				b.classList.toggle('active', b.textContent === 'T' + season);
																		});
																		renderEpisodes();
																});
																seasons.appendChild(btn);
														});

														renderEpisodes();
												})
												.catch(function(err) {
														console.error('Error:', err);
														seasons.innerHTML = '<div class="error">Error al cargar</div>';
												});
								}

								// Renderizar episodios
								function renderEpisodes() {
										var eps = state.currentSeries && state.currentSeries.seasons[state.currentSeason];
										if (!eps || eps.length === 0) {
												episodes.innerHTML = '<div class="empty">No hay episodios</div>';
												return;
										}

										episodes.innerHTML = '';
										eps.forEach(function(ep) {
												var div = document.createElement('div');
												div.className = 'episode';
												div.innerHTML = 
														'<div class="episode-number">' + ep.ep + '</div>' +
														'<div class="episode-info">' +
																'<div class="episode-title">' + escapeHTML(ep.title) + '</div>' +
																'<div class="episode-meta">T' + state.currentSeason + ' E' + ep.ep + '</div>' +
														'</div>';

												div.addEventListener('click', function() {
														if (ep.url) {
																playVideo(ep);
														}
												});

												episodes.appendChild(div);
										});
								}

								// Reproducir video
								function playVideo(ep) {
										console.log('▶️ Reproduciendo:', ep.title);
										var url = ep.url;
										if (url.startsWith('http://')) {
												url = '/video-proxy?url=' + encodeURIComponent(url);
										}
										video.src = url;
										playerTitle.textContent = ep.title;
										player.classList.add('active');
										video.play().catch(function(e) { console.log('Autoplay blocked'); });
								}

								// Cerrar detalle
								function closeDetail() {
										detail.classList.remove('active');
										state.currentSeries = null;
										state.currentSeason = null;
								}

								// Cerrar player
								function closePlayer() {
										video.pause();
										video.src = '';
										player.classList.remove('active');
								}

								// Event listeners
								detailBack.addEventListener('click', closeDetail);
								detailClose.addEventListener('click', closeDetail);
								playerClose.addEventListener('click', closePlayer);

								search.addEventListener('input', debounce(function(e) {
										state.search = e.target.value.trim();
										loadSeries(false);
								}, 300));

								// Scroll infinito
								content.addEventListener('scroll', function() {
										if (state.loading || !state.hasMore) return;
										var scrollTop = content.scrollTop;
										var scrollHeight = content.scrollHeight;
										var clientHeight = content.clientHeight;
										if (scrollTop + clientHeight >= scrollHeight - 200) {
												loadSeries(true);
										}
								});

								// Tecla Escape
								document.addEventListener('keydown', function(e) {
										if (e.key === 'Escape') {
												if (player.classList.contains('active')) {
														closePlayer();
												} else if (detail.classList.contains('active')) {
														closeDetail();
												}
										}
								});

								// Cargar series iniciales
								console.log('📡 Cargando series...');
								loadSeries(false);
						});
				})();
		</script>
</body>
</html>`;

// Servir la página principal
app.get('/', (req, res) => {
		res.setHeader('Content-Type', 'text/html');
		res.send(HTML);
});

// Health check
app.get('/health', (req, res) => {
		res.json({
				status: 'ok',
				uptime: process.uptime(),
				series: SERIES_LIST.length,
				episodes: TOTAL_EPISODES
		});
});

// 404
app.use((req, res) => {
		res.status(404).json({ status: 'error', message: 'Ruta no encontrada' });
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
		console.log('');
		console.log('══════════════════════════════════════');
		console.log('  🎬 STREAM SERIES SERVER');
		console.log('══════════════════════════════════════');
		console.log('  🔗 http://localhost:' + PORT);
		console.log('  📊 Series: ' + SERIES_LIST.length);
		console.log('  📺 Episodios: ' + TOTAL_EPISODES.toLocaleString());
		console.log('  ✅ Datos cargados: ' + DATA_LOADED);
		console.log('══════════════════════════════════════');
});