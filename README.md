# Flex Tupup Backend v1

Clean Node.js + Express + PostgreSQL backend for the Flex Tupup wallet/order/admin workflow.

## Render
- Build command: `npm install`
- Start command: `npm start`
- Add the variables from `.env.example`.
- `DATABASE_URL` must be your Render PostgreSQL connection string.
- `JWT_SECRET` must be a long random secret.
- `CORS_ORIGINS` should contain the exact frontend origin(s), comma-separated.

## Main API
- `GET /health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/games`
- `GET /api/games/:id/packs`
- `GET /api/payment-settings`
- `GET /api/wallet`
- `POST /api/wallet/deposits`
- `GET /api/orders`
- `POST /api/orders`
- `GET /api/notifications`

Admin routes require a JWT belonging to an admin:
- `/api/admin/dashboard`
- `/api/admin/users`
- `/api/admin/games`
- `/api/admin/games/:id/packs`
- `/api/admin/packs/:id`
- `/api/admin/deposits`
- `/api/admin/deposits/:id/approve`
- `/api/admin/deposits/:id/reject`
- `/api/admin/orders`
- `/api/admin/ads`
- `/api/admin/payment-settings`

## Wallet rules
A wallet deposit is always `pending` first. Only an admin approval transaction increases the wallet balance. A purchase uses a database transaction and row lock, so the balance cannot go negative from concurrent purchases.

## Important
This backend does not contain fake payment confirmation or simulated balances. MonCash/NatCash transaction codes are submitted for manual admin verification. Actual automated payment-provider integration can be added later without changing the wallet accounting model.
