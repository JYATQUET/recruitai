// ─── Scoring Constants ───
const HIGH_VALUE_SKILLS = ["sql","jira","uml","bpmn","sap","agile","confluence","power bi","salesforce","azure","aws","python","docker","kubernetes","terraform","rest api","etl"];
const CONSULTING_FIRMS = ["deloitte","accenture","capgemini","pwc","kpmg","ey","sopra","atos","aubay","inetum","delaware","cegeka","cronos","realdolmen","fujitsu","ordina","cipal","smals","nrb"];

// ─── Scoring Engine ───
function scoreProfile(p) {
  let score = 0, breakdown = {}, roleScores = { BA: 0, FA: 0, TA: 0 };

  const baKw = ["business analyst","business analysis","product owner","requirements","stakeholder"];
  const faKw = ["functional analyst","functional analysis","erp","crm","sap","bpmn","process mapping","functional specification"];
  const taKw = ["technical analyst","technical analysis","devops","cloud","architecture","api","etl","developer","infrastructure"];

  const fullText = `${p.headline||""} ${p.about||""} ${p.currentPosition||""} ${(p.experience||[]).map(e=>e.title||e.position||"").join(" ")}`.toLowerCase();
  baKw.forEach(k => { if (fullText.includes(k)) roleScores.BA += 2; });
  faKw.forEach(k => { if (fullText.includes(k)) roleScores.FA += 2; });
  taKw.forEach(k => { if (fullText.includes(k)) roleScores.TA += 2; });
  const detectedRole = Object.entries(roleScores).sort((a,b) => b[1]-a[1])[0][0];

  const totalExp = (p.experience||[]).reduce((acc, exp) => {
    const m = (exp.duration||exp.timePeriod||"").match(/(\d+)\s*yr/i);
    return acc + (m ? parseInt(m[1]) : 0);
  }, 0);
  const expScore = Math.min(30, totalExp * 5);
  breakdown.experience = { score: expScore, max: 30, detail: `${totalExp} ans détectés` };
  score += expScore;

  const profileSkills = (p.skills||[]).map(s => typeof s==="string"?s:s.name||"");
  const matched = profileSkills.filter(s => HIGH_VALUE_SKILLS.some(h => s.toLowerCase().includes(h)));
  const skillScore = Math.min(25, matched.length * 4);
  breakdown.skills = { score: skillScore, max: 25, detail: `${matched.length} compétences clés` };
  score += skillScore;

  const certs = p.certifications||[];
  const certCount = Array.isArray(certs) ? certs.length : 0;
  const certScore = Math.min(20, certCount * 5);
  breakdown.certifications = { score: certScore, max: 20, detail: `${certCount} certification(s)` };
  score += certScore;

  const consultingExp = (p.experience||[]).filter(e => CONSULTING_FIRMS.some(f => (e.company||e.companyName||"").toLowerCase().includes(f)));
  const consultScore = Math.min(15, consultingExp.length * 5);
  breakdown.consulting = { score: consultScore, max: 15, detail: `${consultingExp.length} cabinet(s)` };
  score += consultScore;

  const rawLangs = p.profileLanguages||p.languages||[];
  const langs = Array.isArray(rawLangs) ? rawLangs.map(l => typeof l === "string" ? l : (l && (l.name || l.language || l.title || "")) || "").filter(Boolean) : [];
  const langCount = langs.length;
  const langScore = Math.min(10, langCount * 3 + (langCount >= 3 ? 1 : 0));
  breakdown.languages = { score: langScore, max: 10, detail: langs.join(", ") || `${langCount} langue(s)` };
  score += langScore;

  return { percentage: score, breakdown, detectedRole, roleScores };
}

// Recursively extract a readable string from any Apify value (object, array, string, etc.)
function safeStr(val, fallback) {
  if (val === null || val === undefined) return fallback || "";
  if (typeof val === "string") return val.includes("[object") ? (fallback || "") : val;
  if (Array.isArray(val)) {
    return val.map(v => safeStr(v, "")).filter(Boolean).join(", ") || fallback || "";
  }
  if (typeof val === "object") {
    const tries = ["title", "name", "text", "default", "city", "full", "country", "value", "label", "displayName"];
    for (const key of tries) { if (val[key] && typeof val[key] === "string") return val[key]; }
    const strs = Object.values(val).filter(v => typeof v === "string" && v.length > 0 && !v.includes("[object"));
    return strs.join(", ") || fallback || "";
  }
  return String(val);
}

// Clean ANY string that might still contain [object Object] artifacts
function clean(str) {
  if (!str || typeof str !== "string") return "";
  return str.replace(/\[object Object\]/gi, "").replace(/,\s*,/g, ",").replace(/^[,\s]+|[,\s]+$/g, "").trim();
}

function normalizeProfile(raw, idx) {
  // currentPosition: Apify returns array [{title, companyName}] or object or string
  let currentPos = raw.currentPosition || raw.current_position || "";
  if (Array.isArray(currentPos)) {
    currentPos = currentPos.map(cp => {
      if (typeof cp === "string") return cp;
      if (typeof cp === "object" && cp) {
        const parts = [cp.title || cp.position, cp.companyName || cp.company].filter(Boolean);
        return parts.join(" @ ") || safeStr(cp, "");
      }
      return "";
    }).filter(Boolean).join(", ");
  } else if (typeof currentPos === "object" && currentPos !== null) {
    const parts = [currentPos.title || currentPos.position, currentPos.companyName || currentPos.company].filter(Boolean);
    currentPos = parts.join(" @ ") || safeStr(currentPos, "");
  }
  currentPos = clean(currentPos) || clean(safeStr(raw.headline, ""));

  // location: can be string, object {city, country, region}, or array
  let loc = raw.location || raw.geo || "";
  if (Array.isArray(loc)) {
    loc = loc.map(l => safeStr(l, "")).filter(Boolean).join(", ");
  } else if (typeof loc === "object" && loc !== null) {
    loc = [loc.city, loc.region, loc.state, loc.country].filter(Boolean).join(", ")
      || loc.default || loc.full || safeStr(loc, "");
  }
  loc = clean(loc);

  return {
    id: raw.id || `ap_${Date.now()}_${idx}_${Math.random().toString(36).slice(2,6)}`,
    firstName: clean(safeStr(raw.firstName || raw.first_name, "Inconnu")),
    lastName: clean(safeStr(raw.lastName || raw.last_name, "")),
    headline: clean(safeStr(raw.headline, "")),
    about: clean(safeStr(raw.about || raw.summary, "")) || null,
    currentPosition: currentPos,
    connectionsCount: raw.connectionsCount || raw.connections_count || 0,
    followerCount: raw.followerCount || raw.follower_count || 0,
    education: raw.education || [],
    experience: raw.experience || [],
    certifications: raw.certifications || [],
    skills: Array.isArray(raw.skills) ? raw.skills.map(s => typeof s === "string" ? s : s.name || "").filter(Boolean) : [],
    profileLanguages: (raw.profileLanguages || raw.languages || []).map(l => typeof l === "string" ? l : (l && (l.name || l.language || l.title || l.value || ""))).filter(Boolean),
    location: loc,
    profileUrl: raw.profileUrl || raw.url || raw.linkedinUrl || "#",
    importedAt: raw.importedAt || new Date().toISOString()
  };
}
