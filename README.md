# FLEX TUPUP — Backend rapide Wallet

Ce backend est conçu pour le fichier FLEX TUPUP actuel. Il expose notamment :

- `GET /health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/wallet`
- `POST /api/wallet/deposits`
- `GET /api/wallet/deposits`
- `GET /api/admin/deposits`
- `PATCH /api/admin/deposits/:id` avec `{ "status": "confirmed" }` ou `{ "status": "refused" }`
- `POST /api/admin/deposits/:id/confirm`
- `POST /api/admin/deposits/:id/refuse`
- `GET/POST/PUT/DELETE /api/admin/games...`
- `GET/POST/PUT/DELETE /api/games/:id/packs...`
- `POST /api/orders`, `GET /api/admin/orders`, mise à jour des statuts
- `GET/PUT /api/admin/payment-settings`
- `GET/POST/PATCH /api/admin/notifications...`
- `GET /api/admin/users`

## Déploiement Render

Le service web Render peut être gratuit, mais le service Free peut se mettre en veille après 15 minutes sans trafic et peut prendre environ une minute à se réveiller. Les fichiers locaux d'un service Free ne sont pas persistants. Utilisez donc PostgreSQL pour les données Wallet. Voir la documentation Render officielle.

1. Mettez ce dossier dans un dépôt GitHub.
2. Render → New → Web Service → sélectionnez le dépôt.
3. Build command : `npm install`
4. Start command : `npm start`
5. Plan : Free.
6. Ajoutez les variables de `.env.example`.
7. Utilisez une base PostgreSQL externe fiable avec `DATABASE_URL` (par exemple votre base PostgreSQL existante).

## Point important Wallet

Lorsqu'un admin confirme une recharge, le backend fait une transaction SQL atomique :
1. verrouille le dépôt et l'utilisateur,
2. vérifie que le dépôt est encore `pending`,
3. crédite le montant une seule fois,
4. passe le dépôt à `confirmed`.

Une deuxième tentative de confirmation ne recrédite pas le Wallet.

Le backend ne simule pas un paiement externe : `transaction_reference` est enregistré comme preuve/référence et la confirmation reste une action administrative manuelle.
