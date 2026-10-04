require('dotenv').config();
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { initDb, hasDb } = require('./db');
const { ensurePrincipalAdmin } = require('./auth');

const app = express();
app.set('trust proxy', 1);

// CORS is intentionally handled before every route because the existing FLEX TUPUP
// HTML sends JSON + Authorization headers. Browsers therefore perform an OPTIONS
// preflight before POST /api/wallet/deposits. The local Android file viewer may send
// Origin: null, so that origin is explicitly accepted as well.
const corsOptions = {
  origin(origin, cb) {
    if (!origin || origin === 'null') return cb(null, true);
    const raw = String(process.env.CORS_ORIGINS || '').trim();
    const allowed = raw.split(',').map(x => x.trim()).filter(Boolean);
    if (!raw || allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS_NOT_ALLOWED'));
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Requested-With'],
  exposedHeaders: ['Content-Length'],
  credentials: false,
  optionsSuccessStatus: 204,
  maxAge: 86400
};

app.use(cors(corsOptions));
// Express 5 does not accept the old '*' string pattern reliably; a RegExp safely
// answers preflight requests for every API route.
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store'); next();});
app.use(routes);
app.use((req,res)=>res.status(404).json({error:'NOT_FOUND',message:'Route introuvable.'}));
app.use((err,req,res,next)=>{
  if (err.message === 'CORS_NOT_ALLOWED') return res.status(403).json({error:'CORS_NOT_ALLOWED'});
  console.error(err);
  if (err.status) return res.status(err.status).json({error:err.message});
  if (err.code === '23505') return res.status(409).json({error:'DUPLICATE',message:'Donnée déjà existante.'});
  res.status(500).json({error:'INTERNAL_ERROR',message:'Erreur interne du serveur.'});
});

const port = Number(process.env.PORT || 10000);

(async()=>{
  if (!hasDb) console.warn('DATABASE_URL missing: server will start only so /health can report the configuration problem.');
  if (hasDb) {
    await initDb();
    await ensurePrincipalAdmin();
  }
  app.listen(port,'0.0.0.0',()=>console.log(`FLEX TUPUP backend listening on ${port}`));
})().catch(err=>{
  console.error('Startup failed:',err);
  process.exit(1);
});
