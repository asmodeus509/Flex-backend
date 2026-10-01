
# FLEX TUPUP Backend — Wallet Recharge Ready

This backend fixes the exact missing route from the Wallet screenshot:

POST /api/wallet/deposits

A client submits:
- method: MonCash or NatCash
- amount
- transaction_reference / tx
- phone / senderPhone
- note
- status is always stored as pending

The admin can then confirm or refuse the deposit.

## Deploy on Render

Create a PostgreSQL database on Render (or use another PostgreSQL provider), then create a Web Service from this folder.

Build command:
npm install

Start command:
npm start

Required environment variables:
DATABASE_URL
JWT_SECRET
ADMIN_EMAIL
ADMIN_PASSWORD
CORS_ORIGINS

Recommended:
ADMIN_NAME
ADMIN_PHONE
MONCASH_NUMBER
NATCASH_NUMBER
ADMIN_WHATSAPP
PGSSL=true

## Frontend API URL

Your HTML should use:
https://YOUR-BACKEND.onrender.com/api

For the backend URL you mentioned earlier:
https://flex-new-backend.onrender.com/api

Health test:
https://flex-new-backend.onrender.com/health

## Important

Do not put fake payment confirmation in the frontend.
A deposit remains pending until the admin confirms it through the backend.

The backend credits the wallet only once when a pending deposit is confirmed.
Duplicate transaction references for the same user are rejected.
