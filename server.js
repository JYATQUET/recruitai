const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Data directory & file ───
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "recruitai_data.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      const data = JSON.parse(raw);
      console.log(`  📂 ${data.profiles?.length || 0} profils chargés depuis ${DATA_FILE}`);
      return data;
    }
  } catch (err) {
    console.error("  ⚠ Erreur lecture data:", err.message);
  }
  return { profiles: [], stages: {}, searchHistory: [], lastSaved: null };
}

function saveData(data) {
  try {
    data.lastSaved = new Date().toISOString();

    // Rotate backups: keep last 5
    if (fs.existsSync(DATA_FILE)) {
      const backupPath = path.join(DATA_DIR, `recruitai_backup_${Date.now()}.json`);
      fs.copyFileSync(DATA_FILE, backupPath);

      const backups = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith("recruitai_backup_"))
        .sort()
        .reverse();
      backups.slice(5).forEach(f => fs.unlinkSync(path.join(DATA_DIR, f)));
    }

    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.error("  ⚠ Erreur sauvegarde:", err.message);
    return false;
  }
}

// ─── API: Load all data ───
app.get("/api/data", (req, res) => {
  const data = loadData();
  res.json(data);
});

// ─── API: Save all data (auto-called by frontend) ───
app.post("/api/data", (req, res) => {
  const { profiles, stages, searchHistory } = req.body;
  const ok = saveData({ profiles, stages, searchHistory });
  if (ok) {
    res.json({ success: true, count: profiles?.length || 0 });
  } else {
    res.status(500).json({ error: "Erreur de sauvegarde" });
  }
});

// ─── API: Export CSV ───
app.get("/api/export/csv", (req, res) => {
  const data = loadData();
  const STAGE_LABELS = { new: "Nouveau", contacted: "Contacté", interview: "Entretien", offer: "Offre", rejected: "Rejeté" };

  const headers = ["Prénom", "Nom", "Rôle détecté", "Score", "Étape pipeline", "Titre LinkedIn",
    "Poste actuel", "Localisation", "Compétences", "Certifications", "Langues",
    "Nb connexions", "URL LinkedIn", "Date import"];

  const rows = (data.profiles || []).map(p => {
    const skills = (p.skills || []).join("; ");
    const certs = (p.certifications || []).map(c => typeof c === "string" ? c : c.name || "").join("; ");
    const langs = (p.profileLanguages || []).join("; ");
    return [
      p.firstName, p.lastName, p.detectedRole || "", p.score || "",
      STAGE_LABELS[data.stages?.[p.id]] || "Nouveau",
      `"${(p.headline || "").replace(/"/g, '""')}"`,
      `"${(p.currentPosition || "").replace(/"/g, '""')}"`,
      `"${(p.location || "").replace(/"/g, '""')}"`,
      `"${skills}"`, `"${certs}"`, `"${langs}"`,
      p.connectionsCount || "", p.profileUrl || "", p.importedAt || ""
    ].join(",");
  });

  const csv = "\uFEFF" + [headers.join(","), ...rows].join("\n");
  const filepath = path.join(DATA_DIR, "recruitai_export.csv");
  fs.writeFileSync(filepath, csv, "utf-8");
  res.download(filepath, "recruitai_export.csv");
});

// ─── API: Export Excel ───
app.get("/api/export/excel", (req, res) => {
  const data = loadData();
  const STAGE_LABELS = { new: "Nouveau", contacted: "Contacté", interview: "Entretien", offer: "Offre", rejected: "Rejeté" };

  const rows = (data.profiles || []).map(p => ({
    "Prénom": p.firstName,
    "Nom": p.lastName,
    "Rôle détecté": p.detectedRole || "",
    "Score (/100)": p.score || 0,
    "Étape": STAGE_LABELS[data.stages?.[p.id]] || "Nouveau",
    "Titre LinkedIn": p.headline || "",
    "Poste actuel": p.currentPosition || "",
    "Localisation": p.location || "",
    "Compétences": (p.skills || []).join(", "),
    "Certifications": (p.certifications || []).map(c => typeof c === "string" ? c : c.name || "").join(", "),
    "Langues": (p.profileLanguages || []).join(", "),
    "Connexions": p.connectionsCount || 0,
    "URL LinkedIn": p.profileUrl || "",
    "Date import": p.importedAt || ""
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 10 }, { wch: 12 },
    { wch: 40 }, { wch: 35 }, { wch: 20 }, { wch: 40 }, { wch: 35 },
    { wch: 20 }, { wch: 10 }, { wch: 45 }, { wch: 20 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, "Profils");

  // Summary sheet
  const total = rows.length;
  const summaryData = [
    { "Métrique": "Total profils", "Valeur": total },
    { "Métrique": "Business Analysts (BA)", "Valeur": rows.filter(r => r["Rôle détecté"] === "BA").length },
    { "Métrique": "Functional Analysts (FA)", "Valeur": rows.filter(r => r["Rôle détecté"] === "FA").length },
    { "Métrique": "Technical Analysts (TA)", "Valeur": rows.filter(r => r["Rôle détecté"] === "TA").length },
    { "Métrique": "Score moyen", "Valeur": total ? Math.round(rows.reduce((a, r) => a + (r["Score (/100)"] || 0), 0) / total) : 0 },
    { "Métrique": "Date export", "Valeur": new Date().toLocaleString("fr-BE") },
  ];
  const ws2 = XLSX.utils.json_to_sheet(summaryData);
  ws2["!cols"] = [{ wch: 30 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Résumé");

  const filepath = path.join(DATA_DIR, "recruitai_export.xlsx");
  XLSX.writeFile(wb, filepath);
  res.download(filepath, "recruitai_export.xlsx");
});

// ─── Apify: Start actor run ───
app.post("/api/apify/start", async (req, res) => {
  const { apiKey, search, locations, maxItems, profileLanguages } = req.body;
  if (!apiKey) return res.status(400).json({ error: "Clé API Apify manquante" });

  try {
    const response = await fetch(
      `https://api.apify.com/v2/acts/harvestapi~linkedin-profile-search/runs?token=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search: search || "Functional analyst",
          locations: locations || ["Brussels"],
          maxItems: maxItems || 20,
          profileLanguages: profileLanguages || ["French", "Dutch", "English"],
        }),
      }
    );
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Apify: Check run status ───
app.get("/api/apify/status/:runId", async (req, res) => {
  try {
    const response = await fetch(`https://api.apify.com/v2/actor-runs/${req.params.runId}?token=${req.query.token}`);
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Apify: Get dataset items ───
app.get("/api/apify/dataset/:datasetId", async (req, res) => {
  try {
    const response = await fetch(`https://api.apify.com/v2/datasets/${req.params.datasetId}/items?token=${req.query.token}`);
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Claude AI: Analyze profile ───
app.post("/api/claude/analyze", async (req, res) => {
  const { anthropicKey, prompt } = req.body;
  if (!anthropicKey) return res.status(400).json({ error: "Clé API Anthropic manquante" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Fallback ───
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const data = loadData();
  console.log(`\n  ⬡ RecruitAI running at http://localhost:${PORT}`);
  console.log(`  📂 Data: ${DATA_FILE}`);
  console.log(`  📊 ${data.profiles?.length || 0} profils en base\n`);
});
