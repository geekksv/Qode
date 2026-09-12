// Destination reputation, for a redirector anyone can write to.
//
// The threat is not someone breaking this site. It is someone using it: a
// free, anonymous redirector on a trusted domain is the standard way to
// launder a phishing link past a filter. The cost of getting that wrong is
// not /switch breaking — it is the whole domain landing on Safe Browsing or
// SmartScreen, which takes the Studio and everything else down with it.
//
// Three layers, cheapest first, all applied to creation AND to every later
// change. Checking only at creation would be pointless: make a clean link,
// print it, repoint it at malware the next day.
const https = require("https");

// Other redirectors. Chaining through one hides the real destination from
// anybody inspecting the QR, from this site's own checks, and from whatever
// scanner the visitor's phone uses — which is the entire point of doing it.
// A legitimate switchable code points at a real page.
const REDIRECTORS = new Set([
  "bit.ly", "bitly.com", "j.mp", "tinyurl.com", "t.co", "goo.gl", "ow.ly",
  "buff.ly", "is.gd", "v.gd", "cutt.ly", "rebrand.ly", "shorturl.at",
  "rb.gy", "tiny.cc", "shorte.st", "adf.ly", "bc.vc", "t.ly", "s.id",
  "short.io", "kutt.it", "clck.ru", "vk.cc", "qr.ae", "lnkd.in",
  "trib.al", "dlvr.it", "ift.tt", "tr.im", "chilp.it", "soo.gd",
  "linktr.ee/s", "surl.li", "gg.gg", "urlz.fr", "1url.com", "shrtco.de",
]);

// Free hosting that is overwhelmingly used for phishing pages rather than
// anything else. Not a moral judgement — a statement about what actually
// turns up behind links on services like these.
const HIGH_RISK = new Set([
  "000webhostapp.com", "weeblysite.com", "yolasite.com", "duckdns.org",
  "serveo.net", "loca.lt", "trycloudflare.com", "ngrok.io", "ngrok-free.app",
  "localtunnel.me", "pagekite.me", "glitch.me", "repl.co",
]);

function registrable(hostname) {
  const parts = hostname.toLowerCase().split(".");
  return parts.length <= 2 ? hostname.toLowerCase() : parts.slice(-2).join(".");
}

function staticProblem(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return "That isn't a complete web address.";
  }
  const host = u.hostname.toLowerCase();
  const root = registrable(host);

  if (REDIRECTORS.has(host) || REDIRECTORS.has(root)) {
    return "That's another link shortener. Point the code at the real page instead — " +
      "chaining redirects hides where people actually end up.";
  }
  if (HIGH_RISK.has(root) || HIGH_RISK.has(host)) {
    return "That host isn't accepted here.";
  }
  // Punycode. A domain like xn--pypal-4ve.com renders as pаypal.com with a
  // Cyrillic character, and is indistinguishable on a phone. Legitimate
  // international domains lose out, which is a real cost — but a printed code
  // that opens a lookalike domain is exactly the harm this exists to avoid.
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return "Internationalised domain names aren't accepted here, because they can be made to " +
      "look like other sites.";
  }
  return null;
}

// Google Safe Browsing. Optional: without a key this is skipped entirely and
// the site still works, which is why it is checked rather than assumed.
//
// Deliberately fails OPEN. If Google is unreachable, refusing every new code
// would turn their outage into ours, and the static checks above still apply.
function safeBrowsing(rawUrl) {
  const key = process.env.SAFE_BROWSING_KEY;
  if (!key) return Promise.resolve(null);

  const payload = JSON.stringify({
    client: { clientId: "qode", clientVersion: "1.0.0" },
    threatInfo: {
      threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
      platformTypes: ["ANY_PLATFORM"],
      threatEntryTypes: ["URL"],
      threatEntries: [{ url: rawUrl }],
    },
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "safebrowsing.googleapis.com",
        path: "/v4/threatMatches:find?key=" + encodeURIComponent(key),
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        timeout: 2500,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed && Array.isArray(parsed.matches) && parsed.matches.length) {
              return resolve("That address is flagged as unsafe, so it can't be used here.");
            }
          } catch (e) { /* fail open */ }
          resolve(null);
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function destinationProblem(rawUrl) {
  const stat = staticProblem(rawUrl);
  if (stat) return stat;
  return await safeBrowsing(rawUrl);
}

module.exports = { destinationProblem, staticProblem, REDIRECTORS, HIGH_RISK };
