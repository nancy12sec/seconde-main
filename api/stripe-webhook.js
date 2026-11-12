// Réception des confirmations envoyées par Stripe (webhook).
// La signature est vérifiée avec STRIPE_WEBHOOK_SECRET : un faux appel est refusé.
// Pour l'instant on enregistre l'événement dans le journal ; l'accès se confirme déjà auprès de Stripe côté serveur.

const crypto = require("crypto");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).end();

  const brut = await lireCorpsBrut(req);
  const entete = String(req.headers["stripe-signature"] || "");
  const t = (entete.match(/(?:^|,)t=(\d+)/) || [])[1];
  const signatures = entete.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || signatures.length === 0 || Math.abs(Date.now() / 1000 - Number(t)) > 300) {
    return res.status(400).end();
  }
  const attendu = crypto.createHmac("sha256", secret).update(t + "." + brut).digest("hex");
  const valide = signatures.some((s) => s.length === attendu.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(attendu)));
  if (!valide) return res.status(400).end();

  let evenement;
  try {
    evenement = JSON.parse(brut);
  } catch {
    return res.status(400).end();
  }
  const suivis = ["checkout.session.completed", "invoice.payment_failed", "customer.subscription.deleted"];
  if (suivis.includes(evenement.type)) {
    console.log("Stripe :", evenement.type, evenement.id);
  }
  return res.status(200).json({ recu: true });
};

async function lireCorpsBrut(req) {
  const morceaux = [];
  for await (const m of req) morceaux.push(Buffer.isBuffer(m) ? m : Buffer.from(m));
  if (morceaux.length) return Buffer.concat(morceaux).toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  return "";
}
