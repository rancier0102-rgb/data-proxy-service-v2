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
        if (!fs.existsSync(jsonPath)) {
            console.error('❌ NO EXISTE data.json');
            return;
        }
        const raw = fs.readFileSync(jsonPath, 'utf8');
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) throw new Error('data.json debe ser un array');

        TOTAL_EPISODES = data.length;
        const map = {};
        data.forEach(item => {
            const name = item.series || 'Sin nombre';
            const season = String(item.season || '1');
            if (!map[name]) {
                map[name] = { name, poster: item["logo serie"] || '', seasons: {}, count: 0 };
            }
            if (!map[name].seasons[season]) map[name].seasons[season] = [];
            map[name].seasons[season].push({
                ep: item.ep || 1,
                title: item.title || `Episodio ${item.ep || 1}`,
                url: item.url || ''
            });
            map[name].count++;
        });

        Object.values(map).forEach(series => {
            Object.keys(series.seasons).forEach(season => {
                series.seasons[season].sort((a, b) => a.ep - b.ep);
            });
        });

        SERIES_INDEX = map;
        SERIES_LIST = Object.values(map)
            .map(s => ({ name: s.name, poster: s.poster, seasons: Object.keys(s.seasons).length, count: s.count }))
            .sort((a, b) => a.name.localeCompare(b.name));

        DATA_LOADED = true;
        logger.info(`${SERIES_LIST.length} series, ${TOTAL_EPISODES} episodios`);
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

loadData();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/api/stats', (req, res) => {
    res.json({ status: 'ok', series: SERIES_LIST.length, episodes: TOTAL_EPISODES, loaded: DATA_LOADED });
});

app.get('/api/series', (req, res) => {
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 250;
    const search = (req.query.q || '').toLowerCase();
    const random = req.query.random === 'true';

    let list = [...SERIES_LIST];
    if (search) list = list.filter(s => s.name.toLowerCase().includes(search));
    if (random) {
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
    }

    const total = list.length;
    const start = page * limit;
    res.json({ status: 'ok', total, page, hasMore: start + limit < total, data: list.slice(start, start + limit) });
});

app.get('/api/series/:name', (req, res) => {
    const series = SERIES_INDEX[decodeURIComponent(req.params.name)];
    if (!series) return res.status(404).json({ status: 'error', message: 'No encontrada' });
    res.json({ status: 'ok', data: series });
});

app.get('/video-proxy', videoProxyLimiter, (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).end();
    try {
        const parsed = new URL(decodeURIComponent(url));
        const client = parsed.protocol === 'https:' ? https : http;
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Accept-Encoding': 'identity' }
        };
        if (req.headers.range) opts.headers['Range'] = req.headers.range;

        const proxyReq = client.request(opts, (proxyRes) => {
            if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
                return res.redirect('/video-proxy?url=' + encodeURIComponent(proxyRes.headers.location));
            }
            res.status(proxyRes.statusCode);
            res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/mp4');
            res.setHeader('Accept-Ranges', 'bytes');
            if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
            if (proxyRes.headers['content-range']) res.setHeader('Content-Range', proxyRes.headers['content-range']);
            proxyRes.pipe(res);
        });
        proxyReq.on('error', () => res.status(502).end());
        proxyReq.end();
    } catch (e) {
        res.status(400).end();
    }
});

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <meta name="theme-color" content="#0a0a0a">
    <title>Series+</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;user-select:none}
        :root{--primary:#e50914;--bg:#0a0a0a;--surface:#141414;--text:#fff;--text2:#888;--border:#222}
        html,body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
        #app{min-height:100vh;display:flex;flex-direction:column}
        .header{padding:10px 12px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:100}
        .logo{font-size:18px;font-weight:800;color:var(--primary)}
        #search{flex:1;padding:8px 14px;background:var(--bg);border:1px solid var(--border);border-radius:20px;color:var(--text);font-size:14px;outline:none}
        #search:focus{border-color:var(--primary)}
        .stats{font-size:11px;color:var(--text2)}
        .pull-indicator{text-align:center;padding:15px;color:var(--text2);font-size:13px;display:none}
        .pull-indicator.visible{display:block}
        .pull-indicator.loading::after{content:'';display:inline-block;width:16px;height:16px;margin-left:8px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle}
        .content{flex:1;padding:8px;overflow-y:auto;-webkit-overflow-scrolling:touch}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(85px,1fr));gap:6px}
        @media(min-width:400px){.grid{grid-template-columns:repeat(auto-fill,minmax(95px,1fr));gap:8px}}
        @media(min-width:600px){.grid{grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px}}
        .card{aspect-ratio:2/3;border-radius:6px;overflow:hidden;cursor:pointer;position:relative;background:var(--surface)}
        .card:active{transform:scale(.96)}
        .card-poster{width:100%;height:100%;object-fit:cover;display:block;background:var(--border);opacity:0;transition:opacity .3s}
        .card-poster.loaded{opacity:1}
        .card-poster.error{opacity:.3}
        .card-overlay{position:absolute;bottom:0;left:0;right:0;padding:20px 6px 6px;background:linear-gradient(transparent,rgba(0,0,0,.9));opacity:0;transition:opacity .2s}
        .card:active .card-overlay{opacity:1}
        .card-overlay-title{font-size:10px;font-weight:600;line-height:1.2}
        .detail,.player{position:fixed;inset:0;background:var(--bg);z-index:1000;display:none;flex-direction:column}
        .player{z-index:2000;background:#000}
        .detail.active,.player.active{display:flex}
        .detail-header,.player-header{padding:12px 16px;display:flex;align-items:center;gap:12px;background:var(--surface);border-bottom:1px solid var(--border)}
        .player-header{background:linear-gradient(rgba(0,0,0,.9),transparent);position:absolute;top:0;left:0;right:0;z-index:10;border:none}
        .detail-title,.player-title{flex:1;font-size:16px;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .player-title{font-size:14px;color:#fff}
        .btn-back{background:rgba(255,255,255,.1);border:none;color:var(--text);width:36px;height:36px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px}
        .btn-back:active{background:rgba(255,255,255,.2)}
        .seasons{padding:12px 16px;display:flex;gap:8px;overflow-x:auto;background:var(--surface);border-bottom:1px solid var(--border);-webkit-overflow-scrolling:touch}
        .seasons::-webkit-scrollbar{display:none}
        .season-btn{padding:8px 16px;background:var(--bg);border:1px solid var(--border);border-radius:20px;color:var(--text2);cursor:pointer;white-space:nowrap;font-size:13px}
        .season-btn.active{background:var(--primary);border-color:var(--primary);color:#fff}
        .episodes{flex:1;overflow-y:auto;padding:12px;-webkit-overflow-scrolling:touch}
        .episode{background:var(--surface);border-radius:8px;padding:14px;margin-bottom:8px;cursor:pointer;display:flex;align-items:center;gap:12px}
        .episode:active{background:var(--border)}
        .episode-number{background:var(--primary);color:#fff;min-width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold}
        .episode-info{flex:1;min-width:0}
        .episode-title{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .episode-meta{font-size:11px;color:var(--text2);margin-top:2px}
        .video-container{flex:1;display:flex;align-items:center;justify-content:center;background:#000}
        video{width:100%;height:100%;max-height:100vh}
        .loading,.empty,.error{text-align:center;padding:40px 20px;color:var(--text2);font-size:14px}
        .loading::after{content:'';display:block;width:24px;height:24px;margin:15px auto;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
    </style>
</head>
<body>
    <div id="app">
        <div class="header">
            <div class="logo">STREAM+</div>
            <input type="search" id="search" placeholder="Buscar...">
            <div class="stats" id="stats">...</div>
        </div>
        <div class="pull-indicator" id="pull-indicator">↓ Suelta para mezclar</div>
        <div class="content" id="content">
            <div class="grid" id="grid"><div class="loading">Cargando...</div></div>
        </div>
        <div class="detail" id="detail">
            <div class="detail-header">
                <button class="btn-back" id="detail-back">←</button>
                <div class="detail-title" id="detail-title"></div>
            </div>
            <div class="seasons" id="seasons"></div>
            <div class="episodes" id="episodes"></div>
        </div>
        <div class="player" id="player">
            <div class="player-header">
                <button class="btn-back" id="player-back">←</button>
                <div class="player-title" id="player-title"></div>
            </div>
            <div class="video-container">
                <video id="video" controls playsinline></video>
            </div>
        </div>
    </div>
    <script>
    (function(){
        const state={series:[],page:0,hasMore:true,loading:false,search:'',currentSeries:null,currentSeason:null,currentView:'home'};
        let el={};
        document.addEventListener('DOMContentLoaded',init);
        function init(){
            el={grid:document.getElementById('grid'),content:document.getElementById('content'),search:document.getElementById('search'),stats:document.getElementById('stats'),pullIndicator:document.getElementById('pull-indicator'),detail:document.getElementById('detail'),detailBack:document.getElementById('detail-back'),detailTitle:document.getElementById('detail-title'),seasons:document.getElementById('seasons'),episodes:document.getElementById('episodes'),player:document.getElementById('player'),playerBack:document.getElementById('player-back'),playerTitle:document.getElementById('player-title'),video:document.getElementById('video')};
            fetch('/api/stats').then(r=>r.json()).then(d=>{el.stats.textContent=d.series+' series'}).catch(()=>{});
            loadSeries(false,true);
            setupEvents();
            setupPullRefresh();
            setupBackBtn();
        }
        function loadSeries(append,random){
            if(state.loading)return;
            if(append&&!state.hasMore)return;
            state.loading=true;
            if(!append){el.grid.innerHTML='<div class="loading">Cargando...</div>';state.page=0;state.hasMore=true;state.series=[];}
            let url='/api/series?page='+state.page+'&limit=250';
            if(state.search)url+='&q='+encodeURIComponent(state.search);
            if(random)url+='&random=true';
            fetch(url).then(r=>r.json()).then(data=>{
                if(!append)el.grid.innerHTML='';
                if(data.data.length===0&&!append){el.grid.innerHTML='<div class="empty">No se encontraron series</div>';return;}
                data.data.forEach(s=>{const card=createCard(s);el.grid.appendChild(card);});
                state.series=append?state.series.concat(data.data):data.data;
                state.page++;
                state.hasMore=data.hasMore;
            }).catch(()=>{if(!append)el.grid.innerHTML='<div class="error">Error al cargar</div>';}).finally(()=>{state.loading=false;});
        }
        function createCard(s){
            const card=document.createElement('div');
            card.className='card';
            card.innerHTML='<img class="card-poster" data-src="'+esc(s.poster||'')+'" alt=""><div class="card-overlay"><div class="card-overlay-title">'+esc(s.name)+'</div></div>';
            const img=card.querySelector('.card-poster');
            imgObs.observe(img);
            card.addEventListener('click',()=>openDetail(s.name));
            return card;
        }
        const imgObs=new IntersectionObserver((entries)=>{entries.forEach(e=>{if(e.isIntersecting){const img=e.target;const src=img.dataset.src;if(src){img.src=src;img.onload=()=>img.classList.add('loaded');img.onerror=()=>img.classList.add('error');}else{img.classList.add('error');}imgObs.unobserve(img);}});},{rootMargin:'100px'});
        function openDetail(name){
            state.currentView='detail';
            history.pushState({view:'detail'},'','#detail');
            el.detailTitle.textContent=name;
            el.detail.classList.add('active');
            el.seasons.innerHTML='<div class="loading">Cargando...</div>';
            el.episodes.innerHTML='';
            fetch('/api/series/'+encodeURIComponent(name)).then(r=>r.json()).then(res=>{
                state.currentSeries=res.data;
                const keys=Object.keys(state.currentSeries.seasons).sort((a,b)=>a-b);
                state.currentSeason=keys[0];
                renderSeasons(keys);
                renderEpisodes();
            }).catch(()=>{el.seasons.innerHTML='<div class="error">Error</div>';});
        }
        function renderSeasons(keys){
            el.seasons.innerHTML='';
            keys.forEach(s=>{
                const btn=document.createElement('button');
                btn.className='season-btn'+(s===state.currentSeason?' active':'');
                btn.textContent='T'+s;
                btn.addEventListener('click',()=>{state.currentSeason=s;el.seasons.querySelectorAll('.season-btn').forEach(b=>b.classList.toggle('active',b.textContent==='T'+s));renderEpisodes();});
                el.seasons.appendChild(btn);
            });
        }
        function renderEpisodes(){
            const eps=state.currentSeries&&state.currentSeries.seasons[state.currentSeason];
            if(!eps||eps.length===0){el.episodes.innerHTML='<div class="empty">No hay episodios</div>';return;}
            el.episodes.innerHTML='';
            eps.forEach(ep=>{
                const div=document.createElement('div');
                div.className='episode';
                div.innerHTML='<div class="episode-number">'+ep.ep+'</div><div class="episode-info"><div class="episode-title">'+esc(ep.title)+'</div><div class="episode-meta">Temporada '+state.currentSeason+'</div></div>';
                div.addEventListener('click',()=>{if(ep.url)playVideo(ep);});
                el.episodes.appendChild(div);
            });
        }
        function playVideo(ep){
            state.currentView='player';
            history.pushState({view:'player'},'','#player');
            let url=ep.url;
            if(url.startsWith('http://'))url='/video-proxy?url='+encodeURIComponent(url);
            el.video.src=url;
            el.playerTitle.textContent=ep.title;
            el.player.classList.add('active');
            el.video.play().catch(()=>{});
        }
        function closeDetail(){el.detail.classList.remove('active');state.currentSeries=null;state.currentSeason=null;state.currentView='home';}
        function closePlayer(){el.video.pause();el.video.src='';el.player.classList.remove('active');state.currentView='detail';}
        function setupEvents(){
            el.detailBack.addEventListener('click',closeDetail);
            el.playerBack.addEventListener('click',closePlayer);
            let t;el.search.addEventListener('input',e=>{clearTimeout(t);t=setTimeout(()=>{state.search=e.target.value.trim();loadSeries(false,!state.search);},300);});
            el.content.addEventListener('scroll',()=>{if(state.loading||!state.hasMore)return;const{scrollTop,scrollHeight,clientHeight}=el.content;if(scrollTop+clientHeight>=scrollHeight-300)loadSeries(true,false);});
            document.addEventListener('keydown',e=>{if(e.key==='Escape')handleBack();});
        }
        function setupPullRefresh(){
            let startY=0,pulling=false;
            el.content.addEventListener('touchstart',e=>{if(el.content.scrollTop===0){startY=e.touches[0].pageY;pulling=true;}},{passive:true});
            el.content.addEventListener('touchmove',e=>{if(!pulling)return;const diff=e.touches[0].pageY-startY;el.pullIndicator.classList.toggle('visible',diff>60);},{passive:true});
            el.content.addEventListener('touchend',()=>{if(el.pullIndicator.classList.contains('visible')){el.pullIndicator.textContent='Mezclando...';el.pullIndicator.classList.add('loading');setTimeout(()=>{loadSeries(false,true);el.pullIndicator.classList.remove('visible','loading');el.pullIndicator.textContent='↓ Suelta para mezclar';},500);}pulling=false;},{passive:true});
        }
        function setupBackBtn(){window.addEventListener('popstate',handleBack);}
        function handleBack(){if(state.currentView==='player')closePlayer();else if(state.currentView==='detail')closeDetail();}
        function esc(s){if(!s)return'';return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]);}
    })();
    </script>
</body>
</html>`;

app.get('/',(req,res)=>{res.setHeader('Content-Type','text/html');res.send(HTML);});
app.get('/health',(req,res)=>{res.json({status:'ok',uptime:process.uptime(),series:SERIES_LIST.length,episodes:TOTAL_EPISODES});});
app.use((req,res)=>{res.status(404).json({status:'error',message:'No encontrada'});});

app.listen(PORT,'0.0.0.0',()=>{
    console.log('');
    console.log('══════════════════════════════════════');
    console.log('  🎬 STREAM+ SERVER');
    console.log('══════════════════════════════════════');
    console.log('  🔗 Puerto: '+PORT);
    console.log('  📊 Series: '+SERIES_LIST.length);
    console.log('  📺 Episodios: '+TOTAL_EPISODES);
    console.log('══════════════════════════════════════');
});
