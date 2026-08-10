# Discipline de trading

App Next.js — Scanner, Prix & Niveaux, Dossier d'analyse, Calculateur.

## Lancer en local

```bash
npm install
npm run dev
```

## Déploiement (GitHub → Vercel)

1. Pousse ce dossier sur un repo GitHub.
2. Sur vercel.com → "Add New Project" → importe le repo. Aucune variable
   d'environnement n'est nécessaire (les clés API se collent dans l'app,
   dans le panneau "⚙️ Paramètres", et restent stockées dans le navigateur).

## Clés API (gratuites, à récupérer soi-même)

- **Alpha Vantage** (actions / forex / or) : https://www.alphavantage.co/support/#api-key
  — 25 requêtes/jour sur le plan gratuit.
- **NewsData.io** (sentiment actus, optionnel) : https://newsdata.io/register
  — 200 requêtes/jour sur le plan gratuit.
- **Crypto (CoinGecko)** : aucune clé nécessaire.

## Structure (7 fichiers)

```
package.json
next.config.mjs
app/layout.js
app/globals.css
app/page.js
app/components/TradingApp.jsx   ← toute la logique/UI des 4 onglets
app/api/news/route.js           ← proxy NewsData.io (évite le CORS)
```
