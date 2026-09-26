require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:false}));

const origins=(process.env.CORS_ORIGINS||'*').split(',').map(x=>x.trim()).filter(Boolean);
app.use(cors({origin:(origin,cb)=>{ if(!origin || origins.includes('*') || origins.includes(origin)) return cb(null,true); return cb(new Error('CORS not allowed')); }, credentials:false}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? {rejectUnauthorized:false} : false,
  max:10,
  idleTimeoutMillis:30000,
  connectionTimeoutMillis:10000
});

const JWT_SECRET=process.env.JWT_SECRET;
if(!JWT_SECRET) console.warn('WARNING: JWT_SECRET is not set');

async function query(text,params){return pool.query(text,params)}
async function migrate(){
  await query(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'client' CHECK(role IN ('client','admin')),
    whatsapp TEXT,
    wallet_balance NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK(wallet_balance >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await query(`CREATE TABLE IF NOT EXISTS games (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await query(`CREATE TABLE IF NOT EXISTS packs (
    id BIGSERIAL PRIMARY KEY,
    game_id BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
    price NUMERIC(12,2) NOT NULL CHECK(price >= 0),
    image TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    popular BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await query(`CREATE TABLE IF NOT EXISTS payment_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    moncash_number TEXT,
    natcash_number TEXT,
    whatsapp_number TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await query(`CREATE TABLE IF NOT EXISTS wallet_deposits (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    amount NUMERIC(12,2) NOT NULL CHECK(amount > 0),
    method TEXT NOT NULL CHECK(method IN ('moncash','natcash')),
    transaction_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    admin_note TEXT,
    reviewed_by BIGINT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMPTZ
  );`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS wallet_deposits_tx_unique ON wallet_deposits(method, transaction_code);`);
  await query(`CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    pack_id BIGINT NOT NULL REFERENCES packs(id),
    game_id BIGINT NOT NULL REFERENCES games(id),
    price NUMERIC(12,2) NOT NULL CHECK(price >= 0),
    player_id TEXT,
    whatsapp TEXT,
    status TEXT NOT NULL DEFAULT 'paid' CHECK(status IN ('paid','processing','completed','rejected','cancelled')),
    fulfillment_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await query(`CREATE TABLE IF NOT EXISTS ads (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    image TEXT,
    price NUMERIC(12,2),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await query(`CREATE TABLE IF NOT EXISTS notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await query(`CREATE TABLE IF NOT EXISTS wallet_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK(type IN ('deposit','purchase','adjustment')),
    amount NUMERIC(12,2) NOT NULL,
    reference_type TEXT,
    reference_id BIGINT,
    balance_after NUMERIC(12,2) NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await query(`INSERT INTO payment_settings(id,moncash_number,natcash_number,whatsapp_number) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO NOTHING`,[process.env.MONCASH_NUMBER||'',process.env.NATCASH_NUMBER||'',process.env.WHATSAPP_NUMBER||'50956140799']);
  if(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD){
    const email=process.env.ADMIN_EMAIL.trim().toLowerCase();
    const existing=await query('SELECT id FROM users WHERE email=$1',[email]);
    const hash=await bcrypt.hash(process.env.ADMIN_PASSWORD,12);
    if(existing.rowCount===0) await query('INSERT INTO users(name,email,password_hash,role,whatsapp) VALUES($1,$2,$3,\'admin\',$4)',[process.env.ADMIN_NAME||'Flex Tupup Admin',email,hash,process.env.WHATSAPP_NUMBER||'']);
    else await query('UPDATE users SET role=\'admin\',name=$1,whatsapp=$2,updated_at=NOW() WHERE email=$3',[process.env.ADMIN_NAME||'Flex Tupup Admin',process.env.WHATSAPP_NUMBER||'',email]);
  }
}

function tokenFor(u){return jwt.sign({sub:String(u.id),role:u.role},JWT_SECRET,{expiresIn:'7d'})}
function auth(req,res,next){
  const h=req.headers.authorization||''; if(!h.startsWith('Bearer ')) return res.status(401).json({error:'Authentication required'});
  try{req.auth=jwt.verify(h.slice(7),JWT_SECRET);next()}catch(e){return res.status(401).json({error:'Invalid or expired token'})}
}
function admin(req,res,next){if(req.auth?.role!=='admin') return res.status(403).json({error:'Admin only'});next()}
function cleanUser(r){return {id:r.id,name:r.name,email:r.email,role:r.role,whatsapp:r.whatsapp,walletBalance:Number(r.wallet_balance),active:r.active,createdAt:r.created_at}}
function cleanGame(r){return {id:r.id,name:r.name,image:r.image,active:r.active,sortOrder:r.sort_order}}
function cleanPack(r){return {id:r.id,gameId:r.game_id,name:r.name,quantity:Number(r.quantity),price:Number(r.price),image:r.image,active:r.active,popular:r.popular,sortOrder:r.sort_order}}

app.get('/health',(req,res)=>res.json({ok:true,service:'flex-tupup-backend',time:new Date().toISOString()}));
app.get('/api/health',(req,res)=>res.json({ok:true,service:'flex-tupup-backend',time:new Date().toISOString()}));

app.post('/api/auth/register',async(req,res)=>{try{const {name,email,password,whatsapp}=req.body||{};if(!name||!email||!password||password.length<6)return res.status(400).json({error:'name, email and password (6+) are required'});const e=email.trim().toLowerCase();const hash=await bcrypt.hash(password,12);const r=await query('INSERT INTO users(name,email,password_hash,whatsapp) VALUES($1,$2,$3,$4) RETURNING *',[name.trim(),e,hash,whatsapp||null]);const u=r.rows[0];res.status(201).json({token:tokenFor(u),user:cleanUser(u)})}catch(e){if(e.code==='23505')return res.status(409).json({error:'Email already exists'});console.error(e);res.status(500).json({error:'Registration failed'})}});
app.post('/api/auth/login',async(req,res)=>{try{const {email,password}=req.body||{};const r=await query('SELECT * FROM users WHERE email=$1 AND active=true',[String(email||'').trim().toLowerCase()]);if(!r.rowCount||!(await bcrypt.compare(password||'',r.rows[0].password_hash)))return res.status(401).json({error:'Invalid email or password'});res.json({token:tokenFor(r.rows[0]),user:cleanUser(r.rows[0])})}catch(e){console.error(e);res.status(500).json({error:'Login failed'})}});
app.get('/api/auth/me',auth,async(req,res)=>{const r=await query('SELECT * FROM users WHERE id=$1',[req.auth.sub]);if(!r.rowCount)return res.status(404).json({error:'User not found'});res.json({user:cleanUser(r.rows[0])})});

app.get('/api/payment-settings',async(req,res)=>{const r=await query('SELECT * FROM payment_settings WHERE id=1');res.json(r.rows[0]||{})});
app.put('/api/admin/payment-settings',auth,admin,async(req,res)=>{const {moncashNumber,natcashNumber,whatsappNumber}=req.body||{};const r=await query('UPDATE payment_settings SET moncash_number=$1,natcash_number=$2,whatsapp_number=$3,updated_at=NOW() WHERE id=1 RETURNING *',[moncashNumber||'',natcashNumber||'',whatsappNumber||'']);res.json(r.rows[0])});

app.get('/api/games',async(req,res)=>{const r=await query('SELECT * FROM games WHERE active=true ORDER BY sort_order,id');res.json(r.rows.map(cleanGame))});
app.get('/api/games/:id',async(req,res)=>{const r=await query('SELECT * FROM games WHERE id=$1',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Game not found'});res.json(cleanGame(r.rows[0]))});
app.get('/api/games/:id/packs',async(req,res)=>{const r=await query('SELECT * FROM packs WHERE game_id=$1 AND active=true ORDER BY sort_order,id',[req.params.id]);res.json(r.rows.map(cleanPack))});
app.get('/api/packs/:id',async(req,res)=>{const r=await query('SELECT * FROM packs WHERE id=$1',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Pack not found'});res.json(cleanPack(r.rows[0]))});

app.get('/api/ads',async(req,res)=>{const r=await query('SELECT * FROM ads WHERE active=true ORDER BY sort_order,id DESC');res.json(r.rows)});

app.get('/api/wallet',auth,async(req,res)=>{const r=await query('SELECT id,wallet_balance FROM users WHERE id=$1',[req.auth.sub]);if(!r.rowCount)return res.status(404).json({error:'User not found'});const h=await query('SELECT * FROM wallet_deposits WHERE user_id=$1 ORDER BY id DESC LIMIT 50',[req.auth.sub]);res.json({balance:Number(r.rows[0].wallet_balance),deposits:h.rows})});
app.post('/api/wallet/deposits',auth,async(req,res)=>{try{const {amount,method,transactionCode}=req.body||{};const a=Number(amount);if(!Number.isFinite(a)||a<=0||!['moncash','natcash'].includes(method)||!transactionCode?.trim())return res.status(400).json({error:'amount, method and transactionCode are required'});const r=await query('INSERT INTO wallet_deposits(user_id,amount,method,transaction_code) VALUES($1,$2,$3,$4) RETURNING *',[req.auth.sub,a,method,transactionCode.trim()]);await query(`INSERT INTO notifications(user_id,type,title,message) SELECT id,'wallet_deposit','Recharge en attente',$1 FROM users WHERE role='admin'`,[`Nouvelle recharge de ${a} GDS via ${method}.`]);res.status(201).json(r.rows[0])}catch(e){if(e.code==='23505')return res.status(409).json({error:'This transaction code was already submitted'});console.error(e);res.status(500).json({error:'Deposit submission failed'})}});

app.get('/api/orders',auth,async(req,res)=>{const r=await query(`SELECT o.*,g.name game_name,p.name pack_name FROM orders o JOIN games g ON g.id=o.game_id JOIN packs p ON p.id=o.pack_id WHERE o.user_id=$1 ORDER BY o.id DESC`,[req.auth.sub]);res.json(r.rows)});
app.post('/api/orders',auth,async(req,res)=>{const client=await pool.connect();try{const {packId,playerId,whatsapp}=req.body||{};await client.query('BEGIN');const p=await client.query('SELECT p.*,g.name game_name,g.active game_active FROM packs p JOIN games g ON g.id=p.game_id WHERE p.id=$1 AND p.active=true',[packId]);if(!p.rowCount||!p.rows[0].game_active){await client.query('ROLLBACK');return res.status(404).json({error:'Pack unavailable'})}const pack=p.rows[0];const u=await client.query('SELECT wallet_balance FROM users WHERE id=$1 FOR UPDATE',[req.auth.sub]);const bal=Number(u.rows[0].wallet_balance),price=Number(pack.price);if(bal<price){await client.query('ROLLBACK');return res.status(402).json({error:'Insufficient wallet balance',balance:bal,required:price})}const o=await client.query('INSERT INTO orders(user_id,pack_id,game_id,price,player_id,whatsapp,status) VALUES($1,$2,$3,$4,$5,$6,\'paid\') RETURNING *',[req.auth.sub,pack.id,pack.game_id,price,playerId||null,whatsapp||null]);const nb=bal-price;await client.query('UPDATE users SET wallet_balance=$1,updated_at=NOW() WHERE id=$2',[nb,req.auth.sub]);await client.query('INSERT INTO wallet_ledger(user_id,type,amount,reference_type,reference_id,balance_after,note) VALUES($1,\'purchase\',$2,\'order\',$3,$4,$5)',[req.auth.sub,-price,o.rows[0].id,nb,`Achat ${pack.name}`]);await client.query('INSERT INTO notifications(type,title,message) VALUES(\'new_order\',\'Nouvelle commande\',$1)',[`Commande #${o.rows[0].id} — ${pack.game_name} / ${pack.name}`]);await client.query('COMMIT');res.status(201).json({order:o.rows[0],balance:nb})}catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Order failed'})}finally{client.release()}});

app.get('/api/notifications',auth,async(req,res)=>{const r=await query(`SELECT * FROM notifications WHERE user_id=$1 OR user_id IS NULL ORDER BY id DESC LIMIT 100`,[req.auth.sub]);res.json(r.rows)});
app.post('/api/notifications/:id/read',auth,async(req,res)=>{await query('UPDATE notifications SET read_at=NOW() WHERE id=$1 AND (user_id=$2 OR user_id IS NULL)',[req.params.id,req.auth.sub]);res.json({ok:true})});

// Admin
app.get('/api/admin/dashboard',auth,admin,async(req,res)=>{const [u,o,d,g,p]=await Promise.all([query('SELECT COUNT(*) n FROM users WHERE role=\'client\''),query('SELECT COUNT(*) n FROM orders'),query('SELECT COUNT(*) n FROM wallet_deposits WHERE status=\'pending\''),query('SELECT COUNT(*) n FROM games WHERE active=true'),query('SELECT COUNT(*) n FROM packs WHERE active=true')]);res.json({clients:Number(u.rows[0].n),orders:Number(o.rows[0].n),pendingDeposits:Number(d.rows[0].n),games:Number(g.rows[0].n),packs:Number(p.rows[0].n)})});
app.get('/api/admin/users',auth,admin,async(req,res)=>{const r=await query('SELECT * FROM users ORDER BY id DESC');res.json(r.rows.map(cleanUser))});
app.patch('/api/admin/users/:id',auth,admin,async(req,res)=>{const {name,whatsapp,active,role}=req.body||{};const r=await query('UPDATE users SET name=COALESCE($1,name),whatsapp=COALESCE($2,whatsapp),active=COALESCE($3,active),role=COALESCE($4,role),updated_at=NOW() WHERE id=$5 RETURNING *',[name,whatsapp,active,role,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'User not found'});res.json(cleanUser(r.rows[0]))});
app.get('/api/admin/games',auth,admin,async(req,res)=>{const r=await query('SELECT * FROM games ORDER BY sort_order,id');res.json(r.rows.map(cleanGame))});
app.post('/api/admin/games',auth,admin,async(req,res)=>{const {name,image,active,sortOrder}=req.body||{};if(!name?.trim())return res.status(400).json({error:'name required'});const r=await query('INSERT INTO games(name,image,active,sort_order) VALUES($1,$2,COALESCE($3,true),COALESCE($4,0)) RETURNING *',[name.trim(),image||null,active,sortOrder]);res.status(201).json(cleanGame(r.rows[0]))});
app.patch('/api/admin/games/:id',auth,admin,async(req,res)=>{const {name,image,active,sortOrder}=req.body||{};const r=await query('UPDATE games SET name=COALESCE($1,name),image=COALESCE($2,image),active=COALESCE($3,active),sort_order=COALESCE($4,sort_order),updated_at=NOW() WHERE id=$5 RETURNING *',[name,image,active,sortOrder,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Game not found'});res.json(cleanGame(r.rows[0]))});
app.delete('/api/admin/games/:id',auth,admin,async(req,res)=>{await query('DELETE FROM games WHERE id=$1',[req.params.id]);res.json({ok:true})});
app.get('/api/admin/games/:id/packs',auth,admin,async(req,res)=>{const r=await query('SELECT * FROM packs WHERE game_id=$1 ORDER BY sort_order,id',[req.params.id]);res.json(r.rows.map(cleanPack))});
app.post('/api/admin/games/:id/packs',auth,admin,async(req,res)=>{const {name,quantity,price,image,active,popular,sortOrder}=req.body||{};if(!name||Number(price)<0)return res.status(400).json({error:'name and valid price required'});const r=await query('INSERT INTO packs(game_id,name,quantity,price,image,active,popular,sort_order) VALUES($1,$2,$3,$4,$5,COALESCE($6,true),COALESCE($7,false),COALESCE($8,0)) RETURNING *',[req.params.id,name,Number(quantity||0),Number(price),image||null,active,popular,sortOrder]);res.status(201).json(cleanPack(r.rows[0]))});
app.patch('/api/admin/packs/:id',auth,admin,async(req,res)=>{const {name,quantity,price,image,active,popular,sortOrder}=req.body||{};const r=await query('UPDATE packs SET name=COALESCE($1,name),quantity=COALESCE($2,quantity),price=COALESCE($3,price),image=COALESCE($4,image),active=COALESCE($5,active),popular=COALESCE($6,popular),sort_order=COALESCE($7,sort_order),updated_at=NOW() WHERE id=$8 RETURNING *',[name,quantity,price,image,active,popular,sortOrder,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Pack not found'});res.json(cleanPack(r.rows[0]))});
app.delete('/api/admin/packs/:id',auth,admin,async(req,res)=>{await query('DELETE FROM packs WHERE id=$1',[req.params.id]);res.json({ok:true})});

app.get('/api/admin/deposits',auth,admin,async(req,res)=>{const r=await query(`SELECT d.*,u.name,u.email,u.whatsapp FROM wallet_deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC`);res.json(r.rows)});
app.post('/api/admin/deposits/:id/approve',auth,admin,async(req,res)=>{const c=await pool.connect();try{await c.query('BEGIN');const d=await c.query('SELECT * FROM wallet_deposits WHERE id=$1 FOR UPDATE',[req.params.id]);if(!d.rowCount){await c.query('ROLLBACK');return res.status(404).json({error:'Deposit not found'})}if(d.rows[0].status!=='pending'){await c.query('ROLLBACK');return res.status(409).json({error:'Deposit already reviewed'})}const dep=d.rows[0];const u=await c.query('SELECT wallet_balance FROM users WHERE id=$1 FOR UPDATE',[dep.user_id]);const nb=Number(u.rows[0].wallet_balance)+Number(dep.amount);await c.query('UPDATE users SET wallet_balance=$1,updated_at=NOW() WHERE id=$2',[nb,dep.user_id]);await c.query('UPDATE wallet_deposits SET status=\'approved\',reviewed_by=$1,reviewed_at=NOW(),admin_note=$2 WHERE id=$3',[req.auth.sub,req.body?.note||null,dep.id]);await c.query('INSERT INTO wallet_ledger(user_id,type,amount,reference_type,reference_id,balance_after,note) VALUES($1,\'deposit\',$2,\'wallet_deposit\',$3,$4,$5)',[dep.user_id,Number(dep.amount),dep.id,nb,'Recharge approuvée']);await c.query('INSERT INTO notifications(user_id,type,title,message) VALUES($1,\'wallet_approved\',\'Wallet crédité\',$2)',[dep.user_id,`Votre recharge de ${dep.amount} GDS a été confirmée.`]);await c.query('COMMIT');res.json({ok:true,balance:nb})}catch(e){await c.query('ROLLBACK');console.error(e);res.status(500).json({error:'Approval failed'})}finally{c.release()}});
app.post('/api/admin/deposits/:id/reject',auth,admin,async(req,res)=>{const r=await query('UPDATE wallet_deposits SET status=\'rejected\',reviewed_by=$1,reviewed_at=NOW(),admin_note=$2 WHERE id=$3 AND status=\'pending\' RETURNING *',[req.auth.sub,req.body?.note||null,req.params.id]);if(!r.rowCount)return res.status(409).json({error:'Deposit not found or already reviewed'});await query('INSERT INTO notifications(user_id,type,title,message) VALUES($1,\'wallet_rejected\',\'Recharge refusée\',$2)',[r.rows[0].user_id,`Votre recharge de ${r.rows[0].amount} GDS a été refusée.`]);res.json(r.rows[0])});

app.get('/api/admin/orders',auth,admin,async(req,res)=>{const r=await query(`SELECT o.*,u.name,u.email,u.whatsapp,g.name game_name,p.name pack_name FROM orders o JOIN users u ON u.id=o.user_id JOIN games g ON g.id=o.game_id JOIN packs p ON p.id=o.pack_id ORDER BY o.id DESC`);res.json(r.rows)});
app.patch('/api/admin/orders/:id',auth,admin,async(req,res)=>{const {status,fulfillmentNote}=req.body||{};if(!['paid','processing','completed','rejected','cancelled'].includes(status))return res.status(400).json({error:'Invalid status'});const r=await query('UPDATE orders SET status=$1,fulfillment_note=COALESCE($2,fulfillment_note),updated_at=NOW() WHERE id=$3 RETURNING *',[status,fulfillmentNote,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Order not found'});await query('INSERT INTO notifications(user_id,type,title,message) VALUES($1,\'order_update\',\'Commande mise à jour\',$2)',[r.rows[0].user_id,`Votre commande #${r.rows[0].id} est maintenant: ${status}.`]);res.json(r.rows[0])});

app.get('/api/admin/ads',auth,admin,async(req,res)=>{const r=await query('SELECT * FROM ads ORDER BY sort_order,id DESC');res.json(r.rows)});
app.post('/api/admin/ads',auth,admin,async(req,res)=>{const {title,image,price,active,sortOrder}=req.body||{};if(!title)return res.status(400).json({error:'title required'});const r=await query('INSERT INTO ads(title,image,price,active,sort_order) VALUES($1,$2,$3,COALESCE($4,true),COALESCE($5,0)) RETURNING *',[title,image||null,price==null?null:Number(price),active,sortOrder]);res.status(201).json(r.rows[0])});
app.patch('/api/admin/ads/:id',auth,admin,async(req,res)=>{const {title,image,price,active,sortOrder}=req.body||{};const r=await query('UPDATE ads SET title=COALESCE($1,title),image=COALESCE($2,image),price=COALESCE($3,price),active=COALESCE($4,active),sort_order=COALESCE($5,sort_order),updated_at=NOW() WHERE id=$6 RETURNING *',[title,image,price,active,sortOrder,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Ad not found'});res.json(r.rows[0])});
app.delete('/api/admin/ads/:id',auth,admin,async(req,res)=>{await query('DELETE FROM ads WHERE id=$1',[req.params.id]);res.json({ok:true})});

app.use((err,req,res,next)=>{console.error(err);if(err.message==='CORS not allowed')return res.status(403).json({error:err.message});res.status(500).json({error:'Internal server error'})});
app.use((req,res)=>res.status(404).json({error:'Route not found'}));

const port=Number(process.env.PORT||10000);
migrate().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Flex Tupup backend listening on ${port}`))).catch(e=>{console.error('Startup failed',e);process.exit(1)});
process.on('SIGTERM',async()=>{await pool.end();process.exit(0)});
