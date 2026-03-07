# ⬡ RecruitAI

Outil de recrutement IT — Recherche LinkedIn automatisée, scoring intelligent et pipeline de gestion des candidats.

## Fonctionnalités

- **Recherche LinkedIn intégrée** — Lance des recherches directement via l'API Apify (actor `harvestapi/linkedin-profile-search`)
- **Scoring automatique** — Chaque profil est noté sur 100 selon 5 critères : expérience, compétences, certifications, parcours consulting, langues
- **Détection de rôle** — Classification automatique BA / FA / TA
- **Pipeline de recrutement** — Suivi des candidats : Nouveau → Contacté → Entretien → Offre / Rejeté
- **Analyse AI (Claude)** — Analyse approfondie de chaque profil + génération de messages LinkedIn personnalisés
- **Export CSV** — Exportez vos profils scorés pour usage dans Excel ou autre
- **Persistence locale** — Profils et configuration sauvegardés dans le navigateur (localStorage)

## Installation

```bash
# 1. Installez les dépendances
npm install

# 2. Lancez le serveur
npm start

# 3. Ouvrez votre navigateur
# → http://localhost:3000
```

C'est tout. Pas de base de données, pas de build, pas de Docker.

## Configuration

Au premier lancement, entrez vos clés API dans le panneau de configuration :

| Clé | Où l'obtenir | Requis pour |
|-----|-------------|-------------|
| **Apify API Key** | [console.apify.com](https://console.apify.com) → Settings → Integrations | Recherche LinkedIn |
| **Anthropic API Key** | [console.anthropic.com](https://console.anthropic.com) → API Keys | Analyse AI + messages |

Les clés sont stockées uniquement dans votre navigateur (localStorage), jamais transmises ailleurs que vers les API respectives.

## Utilisation

### Recherche de profils
1. Choisissez un preset (BA, FA, TA) ou tapez vos propres mots-clés
2. Définissez la localisation et le nombre max de profils
3. Cliquez "Lancer la recherche"
4. Les profils sont automatiquement récupérés, scorés et affichés

### Scoring
Le scoring est basé sur 5 axes (100 points max) :
- **Expérience** (30 pts) — Années d'expérience détectées
- **Compétences** (25 pts) — Skills à haute valeur (SQL, JIRA, SAP, UML, Agile, AWS, etc.)
- **Certifications** (20 pts) — Nombre de certifications
- **Consulting IT** (15 pts) — Expérience dans des cabinets de consulting reconnus
- **Langues** (10 pts) — Nombre de langues (bonus pour 3+)

### Analyse AI
Cliquez sur un profil → "Analyse AI + message" pour obtenir :
- Un résumé de pertinence
- Les points forts et points d'attention
- Un message LinkedIn personnalisé prêt à copier

## Coûts estimés

| Service | Coût |
|---------|------|
| Apify (20 profils) | ~$0.18 par recherche |
| Anthropic API (1 analyse) | ~$0.01 par profil |
| **Total pour 100 profils analysés** | **~$2** |

## Structure du projet

```
recruitai/
├── server.js          # Serveur Express (proxy API)
├── package.json
├── public/
│   └── index.html     # Application frontend complète
└── README.md
```

## Personnalisation

### Modifier les critères de scoring
Dans `public/index.html`, modifiez les constantes :
- `HIGH_VALUE_SKILLS` — Liste des compétences valorisées
- `CONSULTING_FIRMS` — Liste des cabinets de consulting reconnus
- Les poids dans `scoreProfile()` — Ajustez les max par catégorie

### Modifier les presets de recherche
Dans la section HTML "presets", ajoutez vos propres combinaisons de mots-clés.
