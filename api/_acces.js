// Outils partagés : accès payant sans base de données.
// L'accès est un jeton signé (cookie) ; sa validité est revérifiée auprès de Stripe à chaque usage.
// Ce fichier commence par « _ » : c'est une bibliothèque, pas une page publique.

const crypto = require("crypto");

const VERSION_STRIPE = "2024-06-20";
const cacheAbonnements = new Map(); // id d'abonnement -> { ok, t }
const usagesPayants = new Map(); // clé client -> horodatages

function secret() {
  return process.env.ACCES_SECRET || "";
}

function signature(corps) {
  return crypto.createHmac("sha256", secret()).update(corps).digest("base64url");
}

function signer(donnees) {
  const corps = Buffer.from(JSON.stringify(donnees)).toString("base64url");
  return corps + "." + signature(corps);
}

function verifier(jeton) {
  if (!jeton || !secret()) return null;
  const morceaux = String(jeton).split(".");
  if (morceaux.length !== 2) return null;
  const corps = morceaux[0];
  const a = Buffer.from(morceaux[1]);
  const b = Buffer.from(signature(corps));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const donnees = JSON.parse(Buffer.from(corps, "base64url").toString("utf8"));
    if (!donnees.exp || Date.now() / 1000 > donnees.exp) return null;
    return donnees;
  } catch {
    return null;
  }
}

function lireCookies(req) {
  const brut = (req.headers && req.headers.cookie) || "";
  const sortie = {};
  brut.split(";").forEach((morceau) => {
    const i = morceau.indexOf("=");
    if (i > 0) {
      try {
        sortie[morceau.slice(0, i).trim()] = decodeURIComponent(morceau.slice(i + 1).trim());
      } catch {
        /* cookie illisible : ignoré */
      }
    }
  });
  return sortie;
}

function poserCookie(res, nom, valeur, secondes) {
  const existant = res.getHeader && res.getHeader("Set-Cookie");
  const liste = Array.isArray(existant) ? existant : existant ? [existant] : [];
  liste.push(nom + "=" + encodeURIComponent(valeur) + "; Path=/; Max-Age=" + secondes + "; HttpOnly; Secure; SameSite=Lax");
  res.setHeader("Set-Cookie", liste);
}

function encoder(objet, prefixe) {
  const morceaux = [];
  for (const [k, v] of Object.entries(objet)) {
    if (v === undefined || v === null) continue;
    const cle = prefixe ? prefixe + "[" + k + "]" : k;
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        const sousCle = cle + "[" + i + "]";
        if (x !== null && typeof x === "object") morceaux.push(encoder(x, sousCle));
        else morceaux.push(encodeURIComponent(sousCle) + "=" + encodeURIComponent(x));
      });
    } else if (typeof v === "object") {
      morceaux.push(encoder(v, cle));
    } else {
      morceaux.push(encodeURIComponent(cle) + "=" + encodeURIComponent(v));
    }
  }
  return morceaux.filter(Boolean).join("&");
}

async function stripeAppel(methode, chemin, params) {
  const cle = process.env.STRIPE_SECRET_KEY;
  if (!cle) throw new Error("stripe-non-configure");
  const options = {
    method: methode,
    headers: { Authorization: "Bearer " + cle, "Stripe-Version": VERSION_STRIPE },
  };
  let url = "https://api.stripe.com/v1" + chemin;
  if (params) {
    const corps = encoder(params);
    if (methode === "GET") {
      if (corps) url += "?" + corps;
    } else {
      options.body = corps;
      options.headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
  }
  const controle = new AbortController();
  const minuterie = setTimeout(() => controle.abort(), 15000);
  try {
    const reponse = await fetch(url, { ...options, signal: controle.signal });
    const donnees = await reponse.json().catch(() => ({}));
    if (!reponse.ok) {
      const erreur = new Error("stripe-" + reponse.status);
      erreur.stripe = donnees;
      throw erreur;
    }
    return donnees;
  } finally {
    clearTimeout(minuterie);
  }
}

function baseUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, "");
  const hote = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return "https://" + hote;
}

// Renvoie { type, cle, pi? } si l'accès est valide, sinon null.
async function verifierDroit(jeton) {
  if (jeton.t === "mensuel" && jeton.sub) {
    const enCache = cacheAbonnements.get(jeton.sub);
    if (enCache && Date.now() - enCache.t < 5 * 60 * 1000) {
      return enCache.ok ? { type: "mensuel", cle: jeton.cus || jeton.sub } : null;
    }
    const abonnement = await stripeAppel("GET", "/subscriptions/" + encodeURIComponent(jeton.sub));
    const ok = abonnement.status === "active" || abonnement.status === "trialing";
    cacheAbonnements.set(jeton.sub, { ok, t: Date.now() });
    return ok ? { type: "mensuel", cle: jeton.cus || jeton.sub } : null;
  }
  if (jeton.t === "annonce" && jeton.pi) {
    const paiement = await stripeAppel("GET", "/payment_intents/" + encodeURIComponent(jeton.pi));
    const utilisee = paiement.metadata && paiement.metadata.utilisee === "1";
    return paiement.status === "succeeded" && !utilisee ? { type: "annonce", cle: jeton.pi, pi: jeton.pi } : null;
  }
  return null;
}

async function marquerUtilisee(pi) {
  await stripeAppel("POST", "/payment_intents/" + encodeURIComponent(pi), { metadata: { utilisee: "1" } });
}

// Usage raisonnable : 30 annonces par heure et par abonné.
function limitePayantAtteinte(cle) {
  const maintenant = Date.now();
  const liste = (usagesPayants.get(cle) || []).filter((t) => maintenant - t < 60 * 60 * 1000);
  if (liste.length >= 30) {
    usagesPayants.set(cle, liste);
    return true;
  }
  liste.push(maintenant);
  usagesPayants.set(cle, liste);
  return false;
}

module.exports = {
  signer,
  verifier,
  lireCookies,
  poserCookie,
  stripeAppel,
  baseUrl,
  verifierDroit,
  marquerUtilisee,
  limitePayantAtteinte,
};
