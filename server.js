import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_IN_ENV';
const DB_FILE = process.env.DB_FILE || 'flex_tupup.sqlite';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@flextupup.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';

if (JWT_SECRET === 'CHANGE_ME_IN_ENV' || JWT_SECRET.length < 32) console.warn('WARNING: set a long random JWT_SECRET in .env');
if (!ADMIN_PASSWORD) console.warn('WARNING: set ADMIN_PASSWORD in .env before production use');

const db = new Database(DB_FILE);
db.pragma('journal_mode=WAL');
db.pragma('foreign_keys=ON');

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || true, credentials: true }));
app.use(express.json({ limit: '3mb' }));
app.use(morgan('tiny'));

const now = () => new Date().toISOString();
const makeId = p => `${p}_${crypto.randomBytes(8).toString('hex')}`;
const money = n => Number(Number(n || 0).toFixed(2));
const clean = (v, max = 160) => String(v ?? '').trim().slice(0, max);

// ---------------- DB ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, contact TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'client',
 balance REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders(
 id TEXT PRIMARY KEY, user_id TEXT, game TEXT NOT NULL, pack TEXT NOT NULL,
 price REAL NOT NULL, uid TEXT DEFAULT '', phone TEXT DEFAULT '', referral_code TEXT DEFAULT '',
 category TEXT NOT NULL, status TEXT NOT NULL, payment TEXT NOT NULL,
 admin_note TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS notifications(
 id TEXT PRIMARY KEY, user_id TEXT, type TEXT NOT NULL, title TEXT NOT NULL,
 message TEXT NOT NULL, payload TEXT DEFAULT '{}', read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referrals(
 id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, affiliate TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS game_rules(game TEXT PRIMARY KEY, category TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS games(
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, image TEXT DEFAULT '',
 enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS packs(
 id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER NOT NULL, category TEXT NOT NULL,
 name TEXT NOT NULL, price REAL NOT NULL, image TEXT DEFAULT '', popular INTEGER NOT NULL DEFAULT 0,
 premium INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS media(key TEXT PRIMARY KEY,url TEXT,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS topups(
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,amount REAL NOT NULL,method TEXT NOT NULL,
 reference TEXT DEFAULT '',status TEXT NOT NULL,admin_note TEXT DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tutorial(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY,actor_id TEXT,action TEXT,entity TEXT,entity_id TEXT,meta TEXT,created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_topups_status ON topups(status,created_at);
`);

function seed() {
  if (!db.prepare('SELECT 1 FROM users WHERE contact=?').get(ADMIN_EMAIL)) {
    if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD must be set for first startup');
    const t = now();
    db.prepare('INSERT INTO users(id,name,contact,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(makeId('USR'), 'FLEX Admin', ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 12), 'admin', t, t);
  }
  const defaults = [
    ['Free Fire','id'], ['Blood Strike','id'], ['eFootball','phone_referral'], ['PUBG Mobile','phone_referral'],
    ['Call of Duty','phone_referral'], ['FC Mobile','phone_referral'], ['DLS 26','phone_referral'], ['Roblox','phone_referral'],
    ['Lords Mobile','phone_referral']
  ];
  const insRule = db.prepare('INSERT OR IGNORE INTO game_rules(game,category) VALUES(?,?)');
  for (const r of defaults) insRule.run(...r);
  const t = now();
  const insGame = db.prepare('INSERT OR IGNORE INTO games(name,image,enabled,created_at,updated_at) VALUES(?,?,?,?,?)');
  for (const [name] of defaults) insGame.run(name, '', 1, t, t);
  db.prepare('INSERT OR IGNORE INTO tutorial(id,config,updated_at) VALUES(1,?,?)').run(JSON.stringify({enabled:true,videoUrl:''}),t);
}
seed();

// ---------------- auth ----------------
function tokenFor(u) { return jwt.sign({ sub:u.id, role:u.role }, JWT_SECRET, { expiresIn:'7d' }); }
function getUser(id) { return db.prepare('SELECT id,name,contact,role,balance,created_at,updated_at FROM users WHERE id=?').get(id); }
function auth(req,res,next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({error:'AUTH_REQUIRED'});
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { return res.status(401).json({error:'INVALID_TOKEN'}); }
}
function optionalAuth(req,res,next) {
  const h=req.headers.authorization||'';
  if (h.startsWith('Bearer ')) { try { req.user=jwt.verify(h.slice(7),JWT_SECRET); } catch {} }
  next();
}
function admin(req,res,next) { auth(req,res,()=>req.user.role==='admin' ? next() : res.status(403).json({error:'ADMIN_REQUIRED'})); }
function audit(actor,action,entity,entityId,meta={}) {
  db.prepare('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?)').run(makeId('AUD'),actor||null,action,entity,entityId||null,JSON.stringify(meta),now());
}

// ---------------- realtime notifications ----------------
const streams = new Set();
function pushEvent(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const s of streams) {
    if (s.userId === null || s.userId === event.userId || event.userId === null) {
      try { s.res.write(data); } catch { streams.delete(s); }
    }
  }
}
function notify({userId=null,type,title,message,payload={}}) {
  const n={id:makeId('NTF'),user_id:userId,type,title,message,payload:JSON.stringify(payload),read:0,created_at:now()};
  db.prepare('INSERT INTO notifications VALUES(?,?,?,?,?,?,?,?)').run(n.id,n.user_id,n.type,n.title,n.message,n.payload,n.read,n.created_at);
  pushEvent({ ...n, payload });
  return n;
}

// ---------------- health/static ----------------
app.get('/api/health',(req,res)=>res.json({ok:true,service:'FLEX TUPUP backend',time:now(),version:'2.0.0'}));
app.post('/api/keep-alive',auth,(req,res)=>res.json({ok:true,time:now()}));
app.get('/api/events',auth,(req,res)=>{
  res.set({ 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no' });
  res.flushHeaders?.();
  const stream={res,userId:req.user.role==='admin'?null:req.user.sub}; streams.add(stream);
  res.write(`data: ${JSON.stringify({type:'connected',time:now()})}\n\n`);
  const timer=setInterval(()=>{ try{res.write(': ping\\n\\n');}catch{} },25000);
  req.on('close',()=>{clearInterval(timer);streams.delete(stream);});
});

// ---------------- auth endpoints ----------------
app.post('/api/auth/register',(req,res)=>{
  const name=clean(req.body?.name,80), contact=clean(req.body?.contact,160), password=String(req.body?.password||'');
  if(!name||!contact||password.length<6) return res.status(400).json({error:'INVALID_INPUT'});
  if(db.prepare('SELECT 1 FROM users WHERE contact=?').get(contact)) return res.status(409).json({error:'CONTACT_EXISTS'});
  const t=now(), u={id:makeId('USR'),name,contact,role:'client'};
  db.prepare('INSERT INTO users(id,name,contact,password_hash,role,balance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(u.id,u.name,u.contact,bcrypt.hashSync(password,12),u.role,0,t,t);
  notify({userId:u.id,type:'welcome',title:'Byenvini',message:'Kont FLEX TUPUP ou pare.'});
  res.status(201).json({token:tokenFor(u),user:getUser(u.id),wallet:{balance:0}});
});
app.post('/api/auth/login',(req,res)=>{
  const contact=clean(req.body?.contact,160), password=String(req.body?.password||'');
  const u=db.prepare('SELECT * FROM users WHERE contact=?').get(contact);
  if(!u||!bcrypt.compareSync(password,u.password_hash)) return res.status(401).json({error:'INVALID_CREDENTIALS'});
  res.json({token:tokenFor(u),user:getUser(u.id),wallet:{balance:u.balance}});
});
app.get('/api/me',auth,(req,res)=>res.json({user:getUser(req.user.sub)}));

// ---------------- wallet/topups ----------------
app.get('/api/wallet',auth,(req,res)=>res.json({wallet:{balance:getUser(req.user.sub).balance,currency:'HTG'}}));
app.get('/api/wallet/transactions',auth,(req,res)=>{
  const rows=db.prepare(`SELECT id,'topup' type,amount,status,method,reference,created_at FROM topups WHERE user_id=?
    UNION ALL SELECT id,'order',-price,status,payment,pack,created_at FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200`).all(req.user.sub,req.user.sub);
  res.json({transactions:rows});
});
app.post('/api/wallet/topup',auth,(req,res)=>{
  const amount=money(req.body?.amount), method=clean(req.body?.method||'manual',50), reference=clean(req.body?.reference||'',120);
  if(amount<=0||amount>Number(process.env.MAX_TOPUP||1000000)) return res.status(400).json({error:'INVALID_AMOUNT'});
  const t={id:makeId('TOP'),user_id:req.user.sub,amount,method,reference,status:'pending',admin_note:'',created_at:now(),updated_at:now()};
  db.prepare('INSERT INTO topups VALUES(?,?,?,?,?,?,?,?,?)').run(t.id,t.user_id,t.amount,t.method,t.reference,t.status,t.admin_note,t.created_at,t.updated_at);
  notify({type:'topup',title:'Nouvo dépôt',message:`${amount} HTG • ${method}`,payload:t});
  res.status(201).json({topup:t,message:'Dépôt soumèt pou validation admin.'});
});

// ---------------- game catalog ----------------
function ruleFor(game) {
  const x=db.prepare('SELECT category FROM game_rules WHERE lower(game)=lower(?)').get(game);
  return x?.category || (/free fire|blood strike/i.test(game)?'id':'phone_referral');
}
app.get('/api/games',(req,res)=>{
  const rows=db.prepare('SELECT id,name,image,enabled FROM games WHERE enabled=1 ORDER BY name').all();
  res.json({games:rows});
});
app.get('/api/games/:id/packs',(req,res)=>{
  const rows=db.prepare(`SELECT p.id,p.category,p.name,p.price,p.image,p.popular,p.premium,p.enabled,g.name game
    FROM packs p JOIN games g ON g.id=p.game_id WHERE p.game_id=? AND p.enabled=1 ORDER BY p.category,p.price`).all(req.params.id);
  res.json(rows);
});
app.get('/api/game-rules',(req,res)=>res.json({rules:Object.fromEntries(db.prepare('SELECT game,category FROM game_rules').all().map(x=>[x.game,x.category]))}));
app.get('/api/referrals',(req,res)=>res.json({referrals:db.prepare('SELECT id,code,affiliate,active,created_at FROM referrals WHERE active=1 ORDER BY created_at DESC').all()}));
app.post('/api/referrals/verify',(req,res)=>{
  const code=clean(req.body?.code,32).toUpperCase();
  const r=db.prepare('SELECT id,code,affiliate,active,created_at FROM referrals WHERE code=? AND active=1').get(code);
  res.json(r?{ok:true,valid:true,referral:r}:{ok:false,valid:false,error:'INVALID_REFERRAL_CODE'});
});

// ---------------- orders ----------------
app.get('/api/orders',auth,(req,res)=>{
  const rows=req.user.role==='admin'?db.prepare('SELECT o.*,u.name,u.contact FROM orders o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 500').all():db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(req.user.sub);
  res.json({orders:rows});
});
app.post('/api/orders',auth,(req,res)=>{
  const b=req.body||{}, game=clean(b.game,100), pack=clean(b.pack,120), price=money(b.price), category=ruleFor(game);
  const phone=clean(b.phone||b.customerContact,40), uid=clean(b.uid,100), ref=clean(b.referral||b.referral_code,32).toUpperCase();
  if(!game||!pack||price<=0) return res.status(400).json({error:'INVALID_ORDER'});
  if(category==='id' && !uid) return res.status(400).json({error:'UID_REQUIRED'});
  if(category==='phone_referral' && (!phone||!ref)) return res.status(400).json({error:'PHONE_AND_REFERRAL_REQUIRED'});
  if(category==='dm_admin' && !phone) return res.status(400).json({error:'PHONE_REQUIRED'});
  if(category==='phone_referral' && !db.prepare('SELECT 1 FROM referrals WHERE code=? AND active=1').get(ref)) return res.status(400).json({error:'INVALID_REFERRAL_CODE'});
  const order= {id:makeId('ORD'),user_id:req.user.sub,game,pack,price,uid,phone,referral_code:category==='phone_referral'?ref:'',category,status:category==='dm_admin'?'admin_request':'pending',payment:category==='dm_admin'?'manual':'wallet',admin_note:category==='dm_admin'?'DM Admin':'',created_at:now(),updated_at:now()};
  try {
    const created=db.transaction(()=>{
      if(category!=='dm_admin'){
        const u=db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.sub);
        if(u.balance<price) throw Object.assign(new Error('INSUFFICIENT_BALANCE'),{code:'INSUFFICIENT_BALANCE'});
        db.prepare('UPDATE users SET balance=balance-?,updated_at=? WHERE id=?').run(price,now(),req.user.sub);
      }
      db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(order));
      notify({type:'new_order',title:category==='dm_admin'?'Nouvelle demande DM Admin':'Nouvelle commande',message:`${game} • ${pack} • ${price} HTG`,payload:order});
      notify({userId:req.user.sub,type:'order_created',title:'Commande soumise',message:`${game} • ${pack} • ${price} HTG`,payload:order});
      audit(req.user.sub,'create','order',order.id,{category,payment:order.payment});
      return order;
    })();
    res.status(201).json({order:created,wallet:{balance:getUser(req.user.sub).balance}});
  } catch(e) { if(e.code==='INSUFFICIENT_BALANCE') return res.status(400).json({error:'INSUFFICIENT_BALANCE'}); console.error(e); res.status(500).json({error:'ORDER_FAILED'}); }
});

// ---------------- notifications ----------------
app.get('/api/notifications',auth,(req,res)=>{
  const rows=req.user.role==='admin'?db.prepare('SELECT * FROM notifications WHERE user_id IS NULL ORDER BY created_at DESC LIMIT 200').all():db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(req.user.sub);
  res.json({notifications:rows.map(x=>({...x,payload:JSON.parse(x.payload||'{}')}))});
});
app.patch('/api/notifications/:id/read',auth,(req,res)=>{db.prepare('UPDATE notifications SET read=1 WHERE id=? AND (user_id=? OR user_id IS NULL)').run(req.params.id,req.user.sub);res.json({ok:true})});
app.post('/api/notifications/read-all',auth,(req,res)=>{if(req.user.role==='admin')db.prepare('UPDATE notifications SET read=1 WHERE user_id IS NULL').run();else db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.sub);res.json({ok:true})});

// ---------------- tutorial/media ----------------
app.get('/api/tutorial',(req,res)=>{const x=db.prepare('SELECT config FROM tutorial WHERE id=1').get();res.json(x?JSON.parse(x.config):{enabled:false})});
app.get('/api/admin/tutorial',admin,(req,res)=>{const x=db.prepare('SELECT config FROM tutorial WHERE id=1').get();res.json(x?JSON.parse(x.config):{})});
app.put('/api/admin/tutorial',admin,(req,res)=>{db.prepare('INSERT OR REPLACE INTO tutorial(id,config,updated_at) VALUES(1,?,?)').run(JSON.stringify(req.body||{}),now());audit(req.user.sub,'update','tutorial','1',req.body||{});res.json({ok:true})});
app.get('/api/admin/media',admin,(req,res)=>res.json({media:db.prepare('SELECT * FROM media').all()}));
app.put('/api/admin/media',admin,(req,res)=>{const media=req.body?.media||req.body||{};db.transaction(()=>{for(const [key,url] of Object.entries(media))db.prepare('INSERT OR REPLACE INTO media(key,url,updated_at) VALUES(?,?,?)').run(clean(key,80),clean(url,2000),now())})();audit(req.user.sub,'update','media','bulk',media);res.json({ok:true})});

// ---------------- admin game/catalog management ----------------
app.get('/api/admin/game-rules',admin,(req,res)=>res.json({rules:Object.fromEntries(db.prepare('SELECT game,category FROM game_rules').all().map(x=>[x.game,x.category]))}));
app.put('/api/admin/game-rules',admin,(req,res)=>{const rules=req.body?.rules||{};for(const [game,category] of Object.entries(rules)){if(!['id','phone_referral','dm_admin'].includes(category))continue;db.prepare('INSERT OR REPLACE INTO game_rules(game,category) VALUES(?,?)').run(clean(game,100),category)}audit(req.user.sub,'update','game_rules','bulk',rules);res.json({ok:true})});
app.get('/api/admin/games',admin,(req,res)=>res.json({games:db.prepare('SELECT * FROM games ORDER BY name').all()}));
app.post('/api/admin/games',admin,(req,res)=>{const name=clean(req.body?.name,100);if(!name)return res.status(400).json({error:'NAME_REQUIRED'});try{const t=now();const x=db.prepare('INSERT INTO games(name,image,enabled,created_at,updated_at) VALUES(?,?,?,?,?)').run(name,clean(req.body?.image,2000),req.body?.enabled===false?0:1,t,t);res.status(201).json({game:db.prepare('SELECT * FROM games WHERE id=?').get(x.lastInsertRowid)})}catch{res.status(409).json({error:'GAME_EXISTS'})}});
app.put('/api/admin/games/:id',admin,(req,res)=>{const g=db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);if(!g)return res.status(404).json({error:'GAME_NOT_FOUND'});db.prepare('UPDATE games SET name=?,image=?,enabled=?,updated_at=? WHERE id=?').run(clean(req.body?.name??g.name,100),clean(req.body?.image??g.image,2000),req.body?.enabled===false?0:1,now(),g.id);res.json({game:db.prepare('SELECT * FROM games WHERE id=?').get(g.id)})});
app.delete('/api/admin/games/:id',admin,(req,res)=>{db.prepare('DELETE FROM games WHERE id=?').run(req.params.id);res.json({ok:true})});
app.get('/api/admin/games/:id/packs',admin,(req,res)=>res.json({packs:db.prepare('SELECT * FROM packs WHERE game_id=? ORDER BY category,price').all(req.params.id)}));
app.post('/api/admin/games/:id/packs',admin,(req,res)=>{const g=db.prepare('SELECT id FROM games WHERE id=?').get(req.params.id);if(!g)return res.status(404).json({error:'GAME_NOT_FOUND'});const name=clean(req.body?.name,120),category=clean(req.body?.category||'Plans',80),price=money(req.body?.price);if(!name||price<=0)return res.status(400).json({error:'INVALID_PACK'});const x=db.prepare('INSERT INTO packs(game_id,category,name,price,image,popular,premium,enabled) VALUES(?,?,?,?,?,?,?,?)').run(g.id,category,name,price,clean(req.body?.image,2000),req.body?.popular?1:0,req.body?.premium?1:0,req.body?.enabled===false?0:1);res.status(201).json({pack:db.prepare('SELECT * FROM packs WHERE id=?').get(x.lastInsertRowid)})});
app.put('/api/admin/packs/:id',admin,(req,res)=>{const p=db.prepare('SELECT * FROM packs WHERE id=?').get(req.params.id);if(!p)return res.status(404).json({error:'PACK_NOT_FOUND'});db.prepare('UPDATE packs SET category=?,name=?,price=?,image=?,popular=?,premium=?,enabled=? WHERE id=?').run(clean(req.body?.category??p.category,80),clean(req.body?.name??p.name,120),money(req.body?.price??p.price),clean(req.body?.image??p.image,2000),req.body?.popular?1:0,req.body?.premium?1:0,req.body?.enabled===false?0:1,p.id);res.json({pack:db.prepare('SELECT * FROM packs WHERE id=?').get(p.id)})});
app.delete('/api/admin/packs/:id',admin,(req,res)=>{db.prepare('DELETE FROM packs WHERE id=?').run(req.params.id);res.json({ok:true})});

// ---------------- admin referrals ----------------
app.get('/api/admin/referrals',admin,(req,res)=>res.json({referrals:db.prepare('SELECT * FROM referrals ORDER BY created_at DESC').all()}));
app.post('/api/admin/referrals',admin,(req,res)=>{const code=clean(req.body?.code,32).toUpperCase(),affiliate=clean(req.body?.affiliate,120);if(!/^[A-Z0-9_-]{3,32}$/.test(code)||!affiliate)return res.status(400).json({error:'INVALID_REFERRAL'});const r={id:makeId('REF'),code,affiliate,active:req.body?.active===false?0:1,created_at:now()};try{db.prepare('INSERT INTO referrals VALUES(?,?,?,?,?)').run(...Object.values(r));audit(req.user.sub,'create','referral',r.id,r);res.status(201).json({referral:r})}catch{res.status(409).json({error:'CODE_EXISTS'})}});
app.put('/api/admin/referrals/:id',admin,(req,res)=>{const old=db.prepare('SELECT * FROM referrals WHERE id=?').get(req.params.id);if(!old)return res.status(404).json({error:'NOT_FOUND'});const code=clean(req.body?.code??old.code,32).toUpperCase();db.prepare('UPDATE referrals SET code=?,affiliate=?,active=? WHERE id=?').run(code,clean(req.body?.affiliate??old.affiliate,120),req.body?.active===false?0:1,old.id);res.json({referral:db.prepare('SELECT * FROM referrals WHERE id=?').get(old.id)})});
app.delete('/api/admin/referrals/:id',admin,(req,res)=>{db.prepare('DELETE FROM referrals WHERE id=?').run(req.params.id);res.json({ok:true})});

// ---------------- admin orders/topups/notifications ----------------
app.patch('/api/admin/orders/:id',admin,(req,res)=>{const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);if(!o)return res.status(404).json({error:'ORDER_NOT_FOUND'});const status=clean(req.body?.status||o.status,40),note=clean(req.body?.admin_note??o.admin_note,500);db.prepare('UPDATE orders SET status=?,admin_note=?,updated_at=? WHERE id=?').run(status,note,now(),o.id);notify({userId:o.user_id,type:'order_update',title:'Mizajou commande',message:`${o.game} • ${status}`,payload:{orderId:o.id,status,note}});audit(req.user.sub,'update','order',o.id,{status,note});res.json({ok:true,order:db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)})});
app.post('/api/admin/notifications',admin,(req,res)=>{const b=req.body||{};const n=notify({type:b.type||'admin',title:clean(b.title||'Notification',120),message:clean(b.message||'',500),payload:b.order||b});res.status(201).json({ok:true,notification:n})});
app.get('/api/admin/topups',admin,(req,res)=>res.json({topups:db.prepare('SELECT t.*,u.name,u.contact FROM topups t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 500').all()}));
function finishTopup(id,status,note,actor){const t=db.prepare('SELECT * FROM topups WHERE id=?').get(id);if(!t||t.status!=='pending')throw Object.assign(new Error('TOPUP_NOT_FOUND'),{code:'TOPUP_NOT_FOUND'});db.transaction(()=>{db.prepare('UPDATE topups SET status=?,admin_note=?,updated_at=? WHERE id=?').run(status,note,t.id);if(status==='approved')db.prepare('UPDATE users SET balance=balance+?,updated_at=? WHERE id=?').run(t.amount,now(),t.user_id);notify({userId:t.user_id,type:`topup_${status}`,title:status==='approved'?'Dépôt approuvé':'Dépôt refusé',message:status==='approved'?`${t.amount} HTG ajouté à votre Wallet.`:`Dépôt refusé: ${note||'contactez admin'}.`,payload:{...t,status,note}});audit(actor,`topup_${status}`,'topup',t.id,{amount:t.amount,note});})();return getUser(t.user_id).balance;}
app.post('/api/admin/topups/:id/approve',admin,(req,res)=>{try{res.json({ok:true,balance:finishTopup(req.params.id,'approved',clean(req.body?.admin_note,500),req.user.sub)})}catch(e){res.status(404).json({error:e.code||'TOPUP_NOT_FOUND'})}});
app.post('/api/admin/topups/:id/reject',admin,(req,res)=>{try{finishTopup(req.params.id,'rejected',clean(req.body?.admin_note,500),req.user.sub);res.json({ok:true})}catch(e){res.status(404).json({error:e.code||'TOPUP_NOT_FOUND'})}});

// ---------------- settings/audit ----------------
app.get('/api/settings',(req,res)=>{const rows=db.prepare('SELECT key,value FROM settings').all();res.json({settings:Object.fromEntries(rows.map(x=>[x.key,x.value]))})});
app.get('/api/admin/audit',admin,(req,res)=>res.json({logs:db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500').all()}));
app.get('/api/admin/users',admin,(req,res)=>res.json({users:db.prepare('SELECT id,name,contact,role,balance,created_at,updated_at FROM users ORDER BY created_at DESC LIMIT 1000').all()}));

// static frontend
app.use(express.static('public'));
app.get('*',(req,res)=>res.sendFile(process.cwd()+'/public/index.html'));

app.listen(PORT,()=>console.log(`FLEX TUPUP backend listening on http://localhost:${PORT}`));
