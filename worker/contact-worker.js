// Cloudflare Worker: receives the BoxBattle contact form and emails it to the owner.
// Needs: a "send_email" binding named EMAIL, and a variable TO_EMAIL (your verified Gmail).
const ALLOWED_ORIGINS = ['https://playdotsandboxes.com', 'https://www.playdotsandboxes.com'];
const FROM_EMAIL = 'noreply@playdotsandboxes.com';

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405, origin);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ ok: false, error: 'Forbidden' }, 403, origin);

    let data;
    try { data = await request.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400, origin); }

    const name = String(data.name || '').trim().slice(0, 100);
    const email = String(data.email || '').trim().slice(0, 200);
    const topic = String(data.subject || 'general').trim().slice(0, 50);
    const message = String(data.message || '').trim().slice(0, 5000);

    if (data.website) return json({ ok: true }, 200, origin); // honeypot: bots fill this, humans don't
    if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ ok: false, error: 'Please fill in all fields correctly.' }, 400, origin);
    }

    try {
      await env.EMAIL.send({
        to: env.TO_EMAIL,
        from: FROM_EMAIL,
        replyTo: email,
        subject: `[BoxBattle] ${topic} from ${name}`,
        text: `Name: ${name}\nEmail: ${email}\nTopic: ${topic}\n\n${message}`,
      });
    } catch (err) {
      console.error('send failed', err);
      return json({ ok: false, error: 'Could not send right now.' }, 502, origin);
    }
    return json({ ok: true }, 200, origin);
  },
};
