# FLEX TUPUP Backend — Complete

Backend Node.js + Express + SQLite pou FLEX TUPUP. Li gen frontend final la nan `public/index.html`, kidonk ou ka lanse backend + sit la ansanm.

## Sa ki ladan
- Register / Login + JWT
- Client/Admin roles
- Wallet HTG
- Top-up manuel + validation/rejection admin
- Pa gen Withdraw endpoint
- Orders + wallet debit atomik
- 3 checkout rules: `id`, `phone_referral`, `dm_admin`
- Free Fire + Blood Strike seeded kòm `id`
- Game rules admin
- Referral codes: create/update/activate/delete/verify
- Games + packs admin CRUD
- Home/product media API
- Tutorial API
- Admin notifications
- Real-time notification stream SSE (`/api/events`)
- Order status updates
- User notifications + read/read-all
- Audit logs
- Health endpoint
- Frontend final la sèvi kòm `public/index.html`

## Enstalasyon
```bash
npm install
cp .env.example .env
```
Mete yon `JWT_SECRET` long/random ak `ADMIN_PASSWORD` reyèl nan `.env`.

## Lanse
```bash
npm start
```
Louvri `http://localhost:3000`.

## API prensipal
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/wallet`
- `POST /api/wallet/topup`
- `GET /api/wallet/transactions`
- `GET /api/games`
- `GET /api/games/:id/packs`
- `GET /api/game-rules`
- `GET /api/referrals`
- `POST /api/referrals/verify`
- `POST /api/orders`
- `GET /api/orders`
- `GET /api/notifications`
- `GET /api/events` (SSE)

### Admin
- `/api/admin/game-rules`
- `/api/admin/referrals`
- `/api/admin/games`
- `/api/admin/games/:id/packs`
- `/api/admin/packs/:id`
- `/api/admin/media`
- `/api/admin/tutorial`
- `/api/admin/orders/:id`
- `/api/admin/topups`
- `/api/admin/topups/:id/approve`
- `/api/admin/topups/:id/reject`
- `/api/admin/notifications`
- `/api/admin/users`
- `/api/admin/audit`

## Checkout rules
Backend la verifye kategori a ankò:
- `id`: UID/ID obligatwa
- `phone_referral`: phone + active referral code obligatwa
- `dm_admin`: phone obligatwa, pa gen debit Wallet otomatik

Pa mete provider/payment secrets nan frontend. Pou yon peman otomatik, konekte yon provider webhook verifye sou backend la; top-up ki nan pakè sa a se flow manuel admin.

## Production
- Mete HTTPS/reverse proxy.
- Mete `JWT_SECRET` ak `ADMIN_PASSWORD` fò nan environment.
- Chanje `CORS_ORIGIN` soti nan `*` pou domain ou.
- Fè backup `flex_tupup.sqlite`.
- Si w vle fulfillment otomatik pou Free Fire/Blood Strike elatriye, konekte API provider jwèt la sou backend la apre payment confirmation.
