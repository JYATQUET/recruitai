// ─── State ───
let profiles = [];
let scorings = {};
let stages = {};
let expandedId = null;
let filterRole = "ALL";
let filterStage = "ALL";
let currentPreset = "Functional analyst";

const AVATAR_COLORS = ["#2563eb", "#9333ea", "#16a34a", "#ea580c", "#0891b2", "#d946ef"];
const ROLE_LABELS = { BA: "Business Analyst", FA: "Functional Analyst", TA: "Technical Analyst" };
const STAGE_CONFIG = {
  new:       { label: "Nouveau",   bg: "#1e293b", color: "#94a3b8", border: "#334155" },
  contacted: { label: "Contacté",  bg: "#1e3a5f", color: "#60a5fa", border: "#2563eb" },
  interview: { label: "Entretien", bg: "#3b1f4a", color: "#c084fc", border: "#9333ea" },
  offer:     { label: "Offre",     bg: "#1a3a2a", color: "#4ade80", border: "#16a34a" },
  rejected:  { label: "Rejeté",    bg: "#3b1515", color: "#f87171", border: "#dc2626" }
};

// ─── Config persistence (API keys stay in localStorage) ───
function saveConfig() {
  localStorage.setItem("recruitai_apify", document.getElementById("apifyKey").value);
  localStorage.setItem("recruitai_anthropic", document.getElementById("anthropicKey").value);
}

let saveTimeout = null;
let lastSaveStatus = "";

function showSaveStatus(msg, isError) {
  lastSaveStatus = msg;
  const el = document.getElementById("saveStatus");
  if (el) {
    el.textContent = msg;
    el.style.color = isError ? "#f87171" : "#4ade80";
    el.style.opacity = "1";
    setTimeout(() => { el.style.opacity = "0.5"; }, 2000);
  }
}

async function saveToServer() {
  // Debounce: wait 500ms after last change before saving
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    try {
      // Enrich profiles with score data before saving
      const enriched = profiles.map(p => {
        const s = scorings[p.id];
        return { ...p, score: s?.percentage || 0, detectedRole: s?.detectedRole || "BA" };
      });

      const res = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profiles: enriched, stages, searchHistory })
      });
      const data = await res.json();
      if (data.success) {
        showSaveStatus(`✓ ${data.count} profils sauvegardés`, false);
      } else {
        showSaveStatus("⚠ Erreur de sauvegarde", true);
      }
    } catch (err) {
      showSaveStatus("⚠ Serveur injoignable", true);
    }
  }, 500);
}

let searchHistory = [];

async function loadFromServer() {
  document.getElementById("apifyKey").value = localStorage.getItem("recruitai_apify") || "";
  document.getElementById("anthropicKey").value = localStorage.getItem("recruitai_anthropic") || "";

  try {
    showSaveStatus("Chargement...", false);
    const res = await fetch("/api/data");
    const data = await res.json();

    profiles = data.profiles || [];
    stages = data.stages || {};
    searchHistory = data.searchHistory || [];

    // Re-normalize ALL profiles through the robust normalizeProfile function
    profiles = profiles.map((p, i) => {
      const fixed = normalizeProfile(p, i);
      fixed.id = p.id;
      fixed.importedAt = p.importedAt || fixed.importedAt;
      return fixed;
    });

    profiles.forEach(p => {
      scorings[p.id] = scoreProfile(p);
      if (!stages[p.id]) stages[p.id] = "new";
    });

    // Re-save with clean data
    saveToServer();

    showSaveStatus(`${profiles.length} profils chargés`, false);
    renderAll();
  } catch (err) {
    showSaveStatus("⚠ Impossible de charger les données", true);
  }
}

// ─── Apify Search ───
let logLines = [];

function addLog(msg, type="info") {
  const time = new Date().toLocaleTimeString();
  logLines.push({ time, msg, type });
  const el = document.getElementById("logConsole");
  el.style.display = "block";
  el.innerHTML = logLines.map(l =>
    `<div class="log-line log-${l.type}"><span class="time">[${l.time}]</span> ${l.msg}</div>`
  ).join("");
  el.scrollTop = el.scrollHeight;
}

async function startSearch() {
  const apiKey = document.getElementById("apifyKey").value.trim();
  const query = document.getElementById("searchQuery").value.trim();
  const location = document.getElementById("searchLocation").value.trim();
  const maxItems = parseInt(document.getElementById("searchMax").value) || 20;

  if (!apiKey) { addLog("Entrez votre clé API Apify dans la configuration", "error"); return; }

  const btn = document.getElementById("searchBtn");
  btn.disabled = true;
  btn.textContent = "⟳ Recherche en cours...";
  logLines = [];
  addLog(`Recherche: "${query}" — Lieu: ${location} — Max: ${maxItems}`);

  try {
    addLog("Démarrage de l'actor harvestapi/linkedin-profile-search...");

    const startRes = await fetch("/api/apify/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey, search: query,
        locations: location.split(",").map(l => l.trim()),
        maxItems,
        profileLanguages: ["French", "Dutch", "English"]
      })
    });

    if (!startRes.ok) {
      const err = await startRes.json();
      addLog(`Erreur API: ${err.error?.slice(0, 200) || startRes.status}`, "error");
      return;
    }

    const runData = await startRes.json();
    const runId = runData.data?.id;
    const datasetId = runData.data?.defaultDatasetId;

    if (!runId) { addLog("Impossible de récupérer l'ID du run", "error"); return; }

    addLog(`Run lancé — ID: ${runId.slice(0, 16)}...`);
    addLog("Polling du statut (toutes les 3s)...");

    // Poll for completion
    const finalDatasetId = await new Promise((resolve, reject) => {
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        try {
          const res = await fetch(`/api/apify/status/${runId}?token=${apiKey}`);
          const data = await res.json();
          const status = data.data?.status;

          if (status === "RUNNING" || status === "READY") {
            if (attempts % 3 === 0) addLog(`Statut: ${status}... (${attempts * 3}s)`);
          } else if (status === "SUCCEEDED") {
            clearInterval(interval);
            addLog("Recherche terminée!", "success");
            resolve(datasetId);
          } else {
            clearInterval(interval);
            addLog(`Statut final: ${status}`, "error");
            reject(new Error(status));
          }
          if (attempts > 80) {
            clearInterval(interval);
            addLog("Timeout après 4 minutes", "error");
            reject(new Error("timeout"));
          }
        } catch (err) { clearInterval(interval); reject(err); }
      }, 3000);
    });

    // Fetch results
    addLog("Téléchargement des profils...");
    const dataRes = await fetch(`/api/apify/dataset/${finalDatasetId}?token=${apiKey}`);
    const rawItems = await dataRes.json();

    const items = extractProfiles(rawItems);

    if (items.length === 0) {
      addLog("⚠ 0 profils retournés. Causes possibles :", "error");
      addLog("  - Limite gratuite Apify atteinte (vérifiez console.apify.com → Runs)", "error");
      addLog("  - La recherche n'a trouvé aucun résultat avec ces critères", "error");
      addLog("  - Essayez plus tard ou depuis la console Apify directement", "error");
    } else {
      addLog(`${items.length} profils récupérés — scoring en cours...`, "success");
      const newProfiles = items.map((item, i) => normalizeProfile(item, i));
      addProfiles(newProfiles, query);
      addLog(`✓ ${newProfiles.length} profils importés et scorés!`, "success");
    }

  } catch (err) {
    addLog(`Erreur: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ Lancer la recherche";
  }
}

function addProfiles(newProfiles, searchQuery) {
  const existingUrls = new Set(profiles.map(p => p.profileUrl));
  const unique = newProfiles.filter(p => !existingUrls.has(p.profileUrl));
  unique.forEach(p => {
    profiles.push(p);
    scorings[p.id] = scoreProfile(p);
    stages[p.id] = "new";
  });

  if (searchQuery) {
    searchHistory.push({
      date: new Date().toISOString(),
      query: searchQuery,
      found: newProfiles.length,
      new: unique.length,
      total: profiles.length
    });
  }

  saveToServer();
  renderAll();
}

// ─── Presets ───
function setPreset(query) {
  currentPreset = query;
  document.getElementById("searchQuery").value = query;
  document.querySelectorAll(".preset-btn").forEach(btn => {
    const presetMap = { "BA": "Business analyst", "FA": "Functional analyst", "TA": "Technical analyst", "BA Agile": "Business analyst Agile Scrum", "FA SAP": "Functional analyst SAP", "TA Cloud": "Technical analyst Cloud DevOps" };
    btn.classList.toggle("active", presetMap[btn.textContent] === query);
  });
}

// ─── JSON Import ───
function toggleJsonImport() {
  const el = document.getElementById("jsonPanel");
  el.style.display = el.style.display === "none" ? "block" : "none";
}

function extractProfiles(data) {
  if (Array.isArray(data)) return data;
  if (typeof data === "object" && data !== null) {
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.data)) return data.data;
    if (data.data && Array.isArray(data.data.items)) return data.data.items;
    if (Array.isArray(data.results)) return data.results;
    if (Array.isArray(data.profiles)) return data.profiles;
    if (data.firstName || data.first_name || data.linkedinUrl || data.publicIdentifier) return [data];
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key]) && data[key].length > 0 && typeof data[key][0] === "object") {
        return data[key];
      }
    }
  }
  return [];
}

function importJson() {
  try {
    const raw = document.getElementById("jsonInput").value.trim();
    if (!raw) { showJsonError("Collez du JSON ici"); return; }
    const data = JSON.parse(raw);
    const arr = extractProfiles(data);
    if (arr.length === 0) {
      showJsonError("Aucun profil trouvé dans ce JSON. Vérifiez le format.");
      return;
    }
    addProfiles(arr.map((p, i) => normalizeProfile(p, i)), "import JSON");
    document.getElementById("jsonPanel").style.display = "none";
    document.getElementById("jsonInput").value = "";
    hideJsonError();
  } catch (err) {
    showJsonError("JSON invalide: " + err.message);
  }
}

// File-based import (avoids copy-paste truncation)
function importJsonFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
      try {
        const data = JSON.parse(ev.target.result);
        const arr = extractProfiles(data);
        if (arr.length === 0) {
          alert("Aucun profil trouvé dans ce fichier.");
          return;
        }
        addProfiles(arr.map((p, i) => normalizeProfile(p, i)), "import fichier: " + file.name);
        document.getElementById("jsonPanel").style.display = "none";
        alert("✓ " + arr.length + " profils importés!");
      } catch (err) {
        alert("Erreur de lecture: " + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function showJsonError(msg) {
  const el = document.getElementById("jsonError");
  el.textContent = msg;
  el.style.display = "block";
}
function hideJsonError() {
  document.getElementById("jsonError").style.display = "none";
}

// ─── Filters ───
function setRoleFilter(role) {
  filterRole = role;
  document.querySelectorAll(".filter-btn").forEach(btn => {
    const btnRole = btn.textContent === "Tous" ? "ALL" : btn.textContent;
    btn.classList.toggle("active", btnRole === role);
  });
  renderProfiles();
}
function setStageFilter(stage) {
  filterStage = filterStage === stage ? "ALL" : stage;
  renderPipeline();
  renderProfiles();
}

// ─── Rendering ───
function renderAll() {
  const hasProfiles = profiles.length > 0;
  document.getElementById("emptyState").style.display = hasProfiles ? "none" : "block";
  document.getElementById("statsSection").style.display = hasProfiles ? "block" : "none";
  if (hasProfiles) { renderStats(); renderPipeline(); renderProfiles(); }
}

function renderStats() {
  const vals = Object.values(scorings);
  const stats = [
    { l: "Total", v: profiles.length, c: "#e2e8f0" },
    { l: "BA", v: vals.filter(s => s.detectedRole==="BA").length, c: "#60a5fa" },
    { l: "FA", v: vals.filter(s => s.detectedRole==="FA").length, c: "#4ade80" },
    { l: "TA", v: vals.filter(s => s.detectedRole==="TA").length, c: "#c084fc" },
    { l: "Score moy.", v: profiles.length ? Math.round(vals.reduce((a,s)=>a+s.percentage,0)/profiles.length) : 0, c: "#f59e0b" },
    { l: "Top", v: vals.filter(s => s.percentage>=75).length, c: "#10b981" }
  ];
  document.getElementById("statsGrid").innerHTML = stats.map(s =>
    `<div class="stat-card"><div class="stat-val" style="color:${s.c}">${s.v}</div><div class="stat-label">${s.l}</div></div>`
  ).join("");
}

function renderPipeline() {
  const counts = {};
  Object.values(stages).forEach(s => { counts[s] = (counts[s]||0)+1; });
  document.getElementById("pipelineBar").innerHTML = Object.entries(STAGE_CONFIG).map(([k, cfg]) =>
    `<div class="pipeline-stage${filterStage===k?" active":""}" onclick="setStageFilter('${k}')">
      <div class="count">${counts[k]||0}</div><div class="label">${cfg.label}</div>
    </div>`
  ).join("");
}

function getFilteredProfiles() {
  const search = (document.getElementById("filterSearch")?.value || "").toLowerCase();
  const sort = document.getElementById("sortSelect")?.value || "score";

  return profiles.filter(p => {
    const s = scorings[p.id]; if (!s) return false;
    if (filterRole !== "ALL" && s.detectedRole !== filterRole) return false;
    if (filterStage !== "ALL" && stages[p.id] !== filterStage) return false;
    if (search) {
      const hay = `${p.firstName} ${p.lastName} ${p.headline} ${(p.skills||[]).join(" ")}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }).sort((a, b) => {
    if (sort === "score") return (scorings[b.id]?.percentage||0) - (scorings[a.id]?.percentage||0);
    if (sort === "name") return `${a.firstName}`.localeCompare(`${b.firstName}`);
    return (scorings[b.id]?.breakdown?.experience?.score||0) - (scorings[a.id]?.breakdown?.experience?.score||0);
  });
}

function renderProfiles() {
  const filtered = getFilteredProfiles();
  const el = document.getElementById("profilesList");

  if (profiles.length > 0 && filtered.length === 0) {
    el.innerHTML = `<div style="text-align:center;padding:50px;color:var(--text-faint)"><div style="font-size:28px">∅</div><div style="margin-top:8px">Aucun profil ne correspond aux filtres</div></div>`;
    return;
  }

  el.innerHTML = filtered.map(p => {
    const s = scorings[p.id];
    const stage = stages[p.id] || "new";
    const isExpanded = expandedId === p.id;
    const ci = (p.firstName||"").charCodeAt(0) % AVATAR_COLORS.length;
    const initials = `${(p.firstName||"?")[0]}${(p.lastName||"?")[0]}`;
    const scoreColor = s.percentage >= 75 ? "#10b981" : s.percentage >= 50 ? "#f59e0b" : s.percentage >= 30 ? "#f97316" : "#ef4444";
    const scoreLabel = s.percentage >= 75 ? "Excellent" : s.percentage >= 50 ? "Bon" : s.percentage >= 30 ? "Moyen" : "Faible";
    const sc = STAGE_CONFIG[stage];

    let expandedHtml = "";
    if (isExpanded) {
      const expHtml = (p.experience||[]).slice(0,5).map(e =>
        `<div class="exp-item"><span class="title">${e.title||e.position||"Poste"}</span> <span class="company">@ ${e.company||e.companyName||"N/A"}</span>${e.duration||e.timePeriod ? ` <span class="duration">· ${e.duration||e.timePeriod}</span>` : ""}</div>`
      ).join("");

      const certsHtml = (p.certifications||[]).map(c => {
        const name = typeof c==="string"?c:c.name||c.title||"";
        return name ? `<span class="cert-tag">${name}</span>` : "";
      }).join("");

      const breakdownHtml = Object.entries(s.breakdown).map(([key, val]) => {
        const labels = { experience:"Expérience", skills:"Compétences", certifications:"Certifications", consulting:"Consulting IT", languages:"Langues" };
        const pct = (val.score / val.max) * 100;
        const barColor = pct > 66 ? "#10b981" : pct > 33 ? "#f59e0b" : "#ef4444";
        return `<div class="breakdown-item">
          <div class="breakdown-header"><span>${labels[key]}</span><span class="breakdown-score">${val.score}/${val.max}</span></div>
          <div class="breakdown-bar"><div class="breakdown-fill" style="width:${pct}%;background:${barColor}"></div></div>
          <div class="breakdown-detail">${val.detail}</div>
        </div>`;
      }).join("");

      const skillsHtml = (p.skills||[]).slice(0,15).map(sk => `<span class="skill-tag">${sk}</span>`).join("");

      expandedHtml = `
        <div class="profile-expanded" onclick="event.stopPropagation()">
          ${p.about ? `<div class="profile-about">${p.about}</div>` : ""}
          <div class="detail-grid">
            <div>
              <div class="section-title">Expérience</div>
              ${expHtml}
              ${certsHtml ? `<div class="section-title" style="margin-top:12px">Certifications</div><div>${certsHtml}</div>` : ""}
            </div>
            <div>
              <div class="section-title">Scoring détaillé</div>
              ${breakdownHtml}
            </div>
          </div>
          <div class="skills-row">${skillsHtml}</div>
          <div class="profile-actions">
            ${p.profileUrl && p.profileUrl !== "#" ? `<a href="${p.profileUrl}" target="_blank" class="btn-linkedin">LinkedIn ↗</a>` : ""}
            <button class="btn-ai" onclick="event.stopPropagation(); openCommModal('${p.id}')">✦ Générer message</button>
            <button class="btn" style="font-size:11px" onclick="event.stopPropagation(); quickMessage('${p.id}')">⚡ Message rapide</button>
          </div>
          ${getCommBadge(p.id)}
        </div>`;
    }

    return `
      <div class="profile-card${isExpanded?" expanded":""}" onclick="toggleProfile('${p.id}')">
        <div class="profile-header">
          <div class="profile-info">
            <div class="avatar" style="background:${AVATAR_COLORS[ci]}">${initials}</div>
            <div class="profile-meta">
              <div class="profile-name-row">
                <span class="profile-name">${p.firstName} ${p.lastName}</span>
                <span class="role-tag role-${s.detectedRole}">${ROLE_LABELS[s.detectedRole]}</span>
              </div>
              <div class="profile-headline">${clean(p.headline)}</div>
              <div class="profile-location">${clean(p.location)}</div>
            </div>
          </div>
          <div class="profile-right">
            <div class="score-wrap">
              <div class="score-ring" style="background:conic-gradient(${scoreColor} ${s.percentage*3.6}deg, #1e293b ${s.percentage*3.6}deg)">
                <div class="score-inner" style="color:${scoreColor}">${s.percentage}</div>
              </div>
              <span class="score-label" style="color:${scoreColor}">${scoreLabel}</span>
            </div>
            <select class="stage-select" style="background:${sc.bg};color:${sc.color};border:1px solid ${sc.border}"
              onclick="event.stopPropagation()" onchange="event.stopPropagation(); changeStage('${p.id}', this.value)">
              ${Object.entries(STAGE_CONFIG).map(([k,v]) => `<option value="${k}"${k===stage?" selected":""}>${v.label}</option>`).join("")}
            </select>
          </div>
        </div>
        ${expandedHtml}
      </div>`;
  }).join("");
}

function toggleProfile(id) {
  expandedId = expandedId === id ? null : id;
  renderProfiles();
}

function changeStage(id, newStage) {
  stages[id] = newStage;
  saveToServer();
  renderPipeline();
  renderProfiles();
}

// ─── Communication Module ───
let communications = {};
let currentCommProfile = null;
let currentCommTab = "generate";
let currentGeneratedMessage = "";

const MESSAGE_TEMPLATES = [
  {
    id: "first_contact",
    name: "Premier contact",
    desc: "Message d'introduction pour établir le contact",
    icon: "👋",
    prompt: `Écris un message LinkedIn de premier contact en français (3-4 phrases max). Le ton doit être professionnel mais chaleureux et humain. Mentionne spécifiquement un élément du profil du candidat qui t'a interpellé. Le but est d'éveiller l'intérêt sans être trop vendeur. Termine par une question ouverte.`
  },
  {
    id: "opportunity",
    name: "Proposition de mission",
    desc: "Présenter une opportunité concrète de mission",
    icon: "💼",
    prompt: `Écris un message LinkedIn pour proposer une mission de consulting IT en Belgique (4-5 phrases). Mentionne que tu recrutes pour une entreprise de consultance IT. Fais référence aux compétences spécifiques du candidat qui correspondent au besoin. Reste assez vague sur le client final mais précis sur le type de rôle. Propose un call de 15 minutes.`
  },
  {
    id: "followup",
    name: "Relance (pas de réponse)",
    desc: "Relancer après un premier message sans réponse",
    icon: "🔄",
    prompt: `Écris un message de relance LinkedIn court (2-3 phrases). Le candidat n'a pas répondu au premier message. Le ton doit être léger et compréhensif, pas insistant. Propose de la valeur ajoutée (un article, un insight sur le marché) ou reformule l'opportunité différemment.`
  },
  {
    id: "followup_positive",
    name: "Suivi (réponse positive)",
    desc: "Répondre à un candidat intéressé",
    icon: "✅",
    prompt: `Écris un message de suivi LinkedIn pour un candidat qui a montré de l'intérêt (3-4 phrases). Remercie pour la réponse, propose un créneau concret pour un call (2-3 options), et indique brièvement ce que vous allez aborder durant l'échange.`
  },
  {
    id: "rejection",
    name: "Déclin poli",
    desc: "Informer que le profil ne correspond pas actuellement",
    icon: "📋",
    prompt: `Écris un message LinkedIn court et respectueux (2-3 phrases) pour informer un candidat que son profil ne correspond pas aux besoins actuels, tout en laissant la porte ouverte pour le futur. Le ton doit être sincère et valorisant.`
  }
];

function loadCommunications() {
  try {
    const saved = localStorage.getItem("recruitai_comms");
    if (saved) communications = JSON.parse(saved);
  } catch(e) {}
}

function saveCommunications() {
  localStorage.setItem("recruitai_comms", JSON.stringify(communications));
}

function getCommBadge(profileId) {
  const comms = communications[profileId];
  if (!comms || comms.length === 0) return "";
  const last = comms[comms.length - 1];
  const date = new Date(last.date).toLocaleDateString("fr-BE", { day: "numeric", month: "short" });
  const colors = { first_contact: "#60a5fa", opportunity: "#c084fc", followup: "#f59e0b", followup_positive: "#4ade80", rejection: "#f87171" };
  const color = colors[last.template] || "#94a3b8";
  return `<div class="comm-badge" style="margin-top:8px">
    <span class="dot" style="background:${color}"></span>
    <span>${comms.length} message(s) · dernier: ${date}</span>
  </div>`;
}

// ─── Communication Modal ───
function openCommModal(profileId) {
  currentCommProfile = profileId;
  currentCommTab = "generate";
  currentGeneratedMessage = "";
  document.getElementById("commModal").style.display = "flex";
  const p = profiles.find(pr => pr.id === profileId);
  document.getElementById("commModalName").textContent = `${p.firstName} ${p.lastName}`;
  renderCommTab();
}

function closeCommModal() {
  document.getElementById("commModal").style.display = "none";
  currentCommProfile = null;
}

function switchCommTab(tab) {
  currentCommTab = tab;
  document.querySelectorAll(".comm-tab").forEach((t, i) => {
    t.classList.toggle("active", ["generate","history","templates"][i] === tab);
  });
  renderCommTab();
}

function renderCommTab() {
  const el = document.getElementById("commTabContent");
  if (currentCommTab === "generate") renderGenerateTab(el);
  else if (currentCommTab === "history") renderHistoryTab(el);
  else if (currentCommTab === "templates") renderTemplatesTab(el);
}

function renderGenerateTab(el) {
  const p = profiles.find(pr => pr.id === currentCommProfile);
  const s = scorings[currentCommProfile];
  if (!p || !s) return;

  const comms = communications[currentCommProfile] || [];
  const suggestedTemplate = comms.length === 0 ? "first_contact" :
    comms.some(c => c.template === "first_contact") ? "followup" : "first_contact";

  el.innerHTML = `
    <div style="margin-bottom:14px">
      <div class="section-title" style="margin-bottom:8px">Choisir le type de message</div>
      <div id="templateSelector">
        ${MESSAGE_TEMPLATES.map(t => `
          <div class="template-card${t.id === suggestedTemplate ? " selected" : ""}" onclick="selectTemplate('${t.id}')">
            <div class="tmpl-name">${t.icon} ${t.name}${t.id === suggestedTemplate ? ' <span style="font-size:9px;color:var(--green-light);font-weight:400">← suggéré</span>' : ""}</div>
            <div class="tmpl-desc">${t.desc}</div>
          </div>
        `).join("")}
      </div>
    </div>
    <div style="margin-bottom:12px">
      <label>Contexte additionnel (optionnel)</label>
      <input type="text" id="commContext" placeholder="Ex: mission SAP chez un client bancaire, disponibilité immédiate requise..." style="margin-top:4px">
    </div>
    <button class="btn-primary" onclick="generateMessage('${suggestedTemplate}')">✦ Générer le message</button>
    <div id="generatedMessageArea"></div>
  `;
}

function selectTemplate(templateId) {
  document.querySelectorAll(".template-card").forEach(card => {
    card.classList.toggle("selected", card.querySelector(".tmpl-name").textContent.includes(
      MESSAGE_TEMPLATES.find(t => t.id === templateId).name
    ));
  });
  const btn = document.querySelector("#commTabContent .btn-primary");
  if (btn) btn.setAttribute("onclick", `generateMessage('${templateId}')`);
}

async function generateMessage(templateId) {
  const p = profiles.find(pr => pr.id === currentCommProfile);
  const s = scorings[currentCommProfile];
  const template = MESSAGE_TEMPLATES.find(t => t.id === templateId);
  const context = document.getElementById("commContext")?.value || "";
  const anthropicKey = document.getElementById("anthropicKey").value.trim();

  if (!anthropicKey) {
    document.getElementById("generatedMessageArea").innerHTML = `
      <div style="margin-top:14px;padding:16px;background:#1a1a2e;border-radius:8px;border:1px solid var(--border-hover)">
        <div style="color:var(--orange);font-size:13px">⚠ Entrez votre clé API Anthropic dans le panneau de configuration</div>
      </div>`;
    return;
  }

  document.getElementById("generatedMessageArea").innerHTML = `
    <div style="text-align:center;padding:30px;color:var(--text-dim)">
      <div class="spinner">⟳</div>
      <div style="margin-top:10px;font-size:12px">Claude rédige le message...</div>
    </div>`;

  const comms = communications[currentCommProfile] || [];
  const historyContext = comms.length > 0
    ? `\n\nHistorique des messages précédents envoyés à ce candidat:\n${comms.map(c => `[${new Date(c.date).toLocaleDateString("fr-BE")}] Type: ${c.template} - "${c.message.slice(0, 100)}..."`).join("\n")}\nAdapte ton message en tenant compte de cet historique.`
    : "";

  const prompt = `${template.prompt}

${context ? `Contexte supplémentaire: ${context}\n` : ""}
Profil du candidat:
Nom: ${p.firstName} ${p.lastName}
Titre: ${clean(p.headline)}
Poste actuel: ${clean(p.currentPosition)}
À propos: ${clean(p.about) || "Non renseigné"}
Expérience: ${(p.experience||[]).slice(0,4).map(e => `${safeStr(e.title||e.position,"?")} @ ${safeStr(e.company||e.companyName,"?")} (${safeStr(e.duration||e.timePeriod,"?")})`).join(", ")}
Compétences clés: ${(p.skills||[]).slice(0,10).join(", ")}
Rôle détecté: ${s.detectedRole} (score: ${s.percentage}/100)${historyContext}

Réponds UNIQUEMENT avec le texte du message, sans guillemets, sans préambule, sans explication. Le message doit être prêt à copier-coller dans LinkedIn.`;

  try {
    const res = await fetch("/api/claude/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anthropicKey, prompt })
    });
    if (!res.ok) throw new Error((await res.json()).error || res.status);

    const data = await res.json();
    currentGeneratedMessage = (data.content||[]).map(c => c.text||"").join("").trim();
    const linkedinUrl = p.profileUrl && p.profileUrl !== "#" ? p.profileUrl : null;

    document.getElementById("generatedMessageArea").innerHTML = `
      <div style="margin-top:16px">
        <div class="section-title" style="margin-bottom:6px">${template.icon} ${template.name}</div>
        <div class="msg-preview" id="msgPreview" contenteditable="true">${currentGeneratedMessage}</div>
        <div style="font-size:10px;color:var(--text-faint);margin-top:4px">💡 Vous pouvez modifier le texte directement ci-dessus avant de copier</div>
        <div class="msg-actions">
          <button class="btn" style="background:var(--blue);color:#fff;border-color:var(--blue)" onclick="copyAndTrack('${templateId}')">
            📋 Copier le message
          </button>
          ${linkedinUrl ? `<a href="${linkedinUrl}" target="_blank" class="btn" style="background:var(--blue-bg);color:var(--blue-light);border-color:var(--blue);text-decoration:none">
            Ouvrir le profil LinkedIn ↗
          </a>` : ""}
          <button class="btn" onclick="markAsSent('${templateId}')">
            ✓ Marquer comme envoyé
          </button>
          <button class="btn" onclick="generateMessage('${templateId}')">
            ↻ Régénérer
          </button>
        </div>
      </div>`;
  } catch (err) {
    document.getElementById("generatedMessageArea").innerHTML = `
      <div style="margin-top:14px;padding:16px;background:#1a1a2e;border-radius:8px;border:1px solid var(--border-hover)">
        <div style="color:var(--orange);font-size:13px">⚠ ${err.message}</div>
      </div>`;
  }
}

function copyAndTrack(templateId) {
  const msg = document.getElementById("msgPreview")?.innerText || currentGeneratedMessage;
  navigator.clipboard.writeText(msg);
  const btns = document.querySelectorAll(".msg-actions .btn");
  if (btns[0]) { btns[0].innerHTML = "✓ Copié!"; btns[0].style.background = "#16a34a"; }
  setTimeout(() => { if (btns[0]) { btns[0].innerHTML = "📋 Copier le message"; btns[0].style.background = "var(--blue)"; } }, 2000);
}

function markAsSent(templateId) {
  const msg = document.getElementById("msgPreview")?.innerText || currentGeneratedMessage;
  if (!communications[currentCommProfile]) communications[currentCommProfile] = [];
  communications[currentCommProfile].push({
    date: new Date().toISOString(),
    template: templateId,
    type: MESSAGE_TEMPLATES.find(t => t.id === templateId)?.name || templateId,
    message: msg
  });
  saveCommunications();

  // Auto-advance pipeline stage
  const currentStage = stages[currentCommProfile];
  if (currentStage === "new") {
    stages[currentCommProfile] = "contacted";
    saveToServer();
    renderPipeline();
  }

  // Visual feedback
  const btn = event.target;
  btn.innerHTML = "✓ Enregistré!";
  btn.style.color = "#4ade80";
  btn.style.borderColor = "#16a34a";
  setTimeout(() => { renderProfiles(); }, 1500);
}

function renderHistoryTab(el) {
  const comms = communications[currentCommProfile] || [];
  if (comms.length === 0) {
    el.innerHTML = `<div class="history-empty">
      <div style="font-size:24px;margin-bottom:10px">📭</div>
      Aucun message envoyé à ce candidat.<br>
      <span style="font-size:11px">Utilisez l'onglet "Générer un message" pour commencer.</span>
    </div>`;
    return;
  }

  el.innerHTML = `
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">${comms.length} message(s) envoyé(s)</div>
    ${comms.slice().reverse().map(c => {
      const tmpl = MESSAGE_TEMPLATES.find(t => t.id === c.template);
      const date = new Date(c.date).toLocaleDateString("fr-BE", { day:"numeric", month:"long", year:"numeric", hour:"2-digit", minute:"2-digit" });
      return `
        <div class="history-item">
          <div class="hist-header">
            <span class="hist-type">${tmpl?.icon || "📨"} ${c.type || c.template}</span>
            <span class="hist-date">${date}</span>
          </div>
          <div class="hist-msg">${c.message}</div>
          <button class="btn" style="margin-top:8px;font-size:10px" onclick="navigator.clipboard.writeText(this.parentElement.querySelector('.hist-msg').textContent)">Recopier</button>
        </div>`;
    }).join("")}
  `;
}

function renderTemplatesTab(el) {
  el.innerHTML = `
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">Templates de messages disponibles. Cliquez pour générer.</div>
    ${MESSAGE_TEMPLATES.map(t => `
      <div class="template-card" onclick="switchCommTab('generate'); setTimeout(() => { selectTemplate('${t.id}'); generateMessage('${t.id}'); }, 100)">
        <div class="tmpl-name">${t.icon} ${t.name}</div>
        <div class="tmpl-desc">${t.desc}</div>
      </div>
    `).join("")}
    <div style="margin-top:16px;padding:14px;background:var(--bg-deep);border-radius:8px;border:1px solid var(--border)">
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:6px">💡 ASTUCE</div>
      <div style="font-size:12px;color:var(--text-dim);line-height:1.6">
        Utilisez le champ "Contexte additionnel" dans l'onglet Générer pour personnaliser davantage. Par exemple : le nom du client, le type de mission, le TJR, la date de démarrage...
      </div>
    </div>
  `;
}

// ─── Quick Message (from profile card) ───
async function quickMessage(profileId) {
  const p = profiles.find(pr => pr.id === profileId);
  const s = scorings[profileId];
  const anthropicKey = document.getElementById("anthropicKey").value.trim();

  if (!anthropicKey) { openCommModal(profileId); return; }

  const comms = communications[profileId] || [];
  const templateId = comms.length === 0 ? "first_contact" : "followup";
  const template = MESSAGE_TEMPLATES.find(t => t.id === templateId);

  const prompt = `${template.prompt}

Profil: ${p.firstName} ${p.lastName}, ${clean(p.headline)}.
Compétences: ${(p.skills||[]).slice(0,6).join(", ")}.
Rôle: ${s.detectedRole}.

Réponds UNIQUEMENT avec le texte du message, prêt à copier-coller.`;

  try {
    const res = await fetch("/api/claude/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anthropicKey, prompt })
    });
    if (!res.ok) throw new Error("API error");
    const data = await res.json();
    const msg = (data.content||[]).map(c => c.text||"").join("").trim();
    await navigator.clipboard.writeText(msg);
    alert(`✓ Message "${template.name}" copié!\n\nOuvrez LinkedIn pour le coller.\n\n---\n${msg.slice(0, 200)}...`);
  } catch {
    openCommModal(profileId);
  }
}

function closeAiModal() { closeCommModal(); }

// ─── Init ───
document.addEventListener("DOMContentLoaded", () => {
  loadFromServer();
  loadCommunications();
});
