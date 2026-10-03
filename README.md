# FLEX TUPUP Wallet Backend — Manual Validation v2

Backend for the existing FLEX TUPUP HTML. It does NOT simulate external payments.

Wallet flow:
1. Client submits amount + MonCash/NatCash transaction reference.
2. Server stores it as `pending` in PostgreSQL.
3. Admin checks the transaction manually with MonCash/NatCash.
4. Admin clicks Confirm or Refuse.
5. Confirm performs one atomic SQL transaction that credits the client's `wallet_balance` and marks the deposit `confirmed`.
6. Refuse marks it `refused` without crediting the wallet.

Routes:
- GET /health
- POST /api/auth/register
- POST /api/auth/login
- GET /api/me
- GET /api/wallet
- POST /api/wallet/deposits
- GET /api/wallet/deposits
- GET /api/admin/deposits
- POST /api/admin/deposits/:id/confirm
- POST /api/admin/deposits/:id/refuse
- POST /api/admin/deposits/:id/validate
- PATCH /api/admin/deposits/:id

Required Render environment variables:
DATABASE_URL
JWT_SECRET
ADMIN_EMAIL
ADMIN_PASSWORD
ADMIN_NAME
CORS_ORIGINS
MAX_WALLET_DEPOSIT=500000
MIN_WALLET_DEPOSIT=1

`initDb()` includes non-destructive compatibility migrations for older databases.
