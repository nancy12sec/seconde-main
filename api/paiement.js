// Fonction serveur du paiement.
//  POST { action: "checkout", formule: "mensuel" | "annonce" } -> prépare le paiement intégré à la page
//  POST { action: "portail" }                                   -> ouvre le portail de gestion / résiliation
//  GET  ?session_id=cs_...                                      -> confirme le paiement auprès de Stripe, pose l'accès
//  GET  (sans paramètre)                                        -> dit quelle formule est active sur cet appareil
// Aucun secret n'est envoyé au navigateur, sauf la clé publique de Stripe, qui est faite pour l'être.

const acces = require("./_acces");

const UN_JOUR = 24 * 60 * 60;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") return lireAcces(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ erreur: "Méthode non autorisée." });
  }

  const corps = typeof req.body === "string" ? safeParse(req.body) : req.body;
  const action = corps && corps.action;
  if (action === "checkout") return creerPaiement(req, res, corps);
  if (action === "portail") return ouvrirPortail(req, res);
  return res.status(400).json({ erreur: "Demande inconnue." });
};

async function creerPaiement(req, res, corps) {
  const formule = corps.formule;
  const prix =
    formule === "mensuel" ? process.env.STRIPE_PRICE_MENSUEL : formule === "annonce" ? process.env.STRIPE_PRICE_ANNONCE : null;
  if (formule !== "mensuel" && formule !== "annonce") {
    return res.status(400).json({ erreur: "Formule inconnue." });
  }
  if (!prix || !process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PUBLISHABLE_KEY || !process.env.ACCES_SECRET) {
    return res.status(503).json({ erreur: "Le paiement n'est pas encore branché. Réessaie plus tard." });
  }
  try {
    const params = {
      ui_mode: "embedded",
      mode: formule === "mensuel" ? "subscription" : "payment",
      line_items: [{ price: prix, quantity: 1 }],
      return_url: acces.baseUrl(req) + "/merci.html?session_id={CHECKOUT_SESSION_ID}",
      locale: "fr",
      metadata: { formule },
    };
    if (formule === "annonce") params.customer_creation = "always";
    const session = await acces.stripeAppel("POST", "/checkout/sessions", params);
    return res.status(200).json({ clientSecret: session.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
  } catch (e) {
    console.error("Paiement non démarré :", e.message, e.stripe && e.stripe.error && e.stripe.error.message);
    return res.status(502).json({ erreur: "Le paiement n'a pas pu démarrer. Tu n'as pas été débité. Réessaie dans un instant." });
  }
}

async function lireAcces(req, res) {
  const sessionId = req.query && req.query.session_id;
  if (!sessionId) {
    const jeton = acces.verifier(acces.lireCookies(req).sm_acces);
    return res.status(200).json({ formule: jeton ? jeton.t : null });
  }
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(String(sessionId))) {
    return res.status(400).json({ erreur: "Identifiant de paiement invalide." });
  }
  try {
    const session = await acces.stripeAppel("GET", "/checkout/sessions/" + encodeURIComponent(sessionId));
    const paye = session.status === "complete" && (session.payment_status === "paid" || session.payment_status === "no_payment_required");
    if (!paye) {
      return res.status(402).json({ erreur: "Le paiement n'est pas confirmé." });
    }
    const maintenant = Math.floor(Date.now() / 1000);
    let jeton;
    if (session.mode === "subscription" && session.subscription) {
      jeton = { t: "mensuel", cus: session.customer, sub: session.subscription, exp: maintenant + 400 * UN_JOUR };
    } else if (session.mode === "payment" && session.payment_intent) {
      jeton = { t: "annonce", cus: session.customer, pi: session.payment_intent, exp: maintenant + 30 * UN_JOUR };
    } else {
      return res.status(402).json({ erreur: "Le paiement n'est pas confirmé." });
    }
    acces.poserCookie(res, "sm_acces", acces.signer(jeton), jeton.exp - maintenant);
    return res.status(200).json({ ok: true, formule: jeton.t });
  } catch (e) {
    console.error("Vérification du paiement impossible :", e.message);
    return res.status(502).json({ erreur: "Impossible de vérifier le paiement pour le moment. Réessaie dans un instant." });
  }
}

async function ouvrirPortail(req, res) {
  const jeton = acces.verifier(acces.lireCookies(req).sm_acces);
  if (!jeton || jeton.t !== "mensuel" || !jeton.cus) {
    return res.status(401).json({ erreur: "Aucun abonnement actif sur cet appareil." });
  }
  try {
    const session = await acces.stripeAppel("POST", "/billing_portal/sessions", {
      customer: jeton.cus,
      return_url: acces.baseUrl(req) + "/avant-gout.html",
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("Portail indisponible :", e.message, e.stripe && e.stripe.error && e.stripe.error.message);
    return res.status(502).json({ erreur: "La gestion de l'abonnement est momentanément indisponible. Réessaie dans un instant." });
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
