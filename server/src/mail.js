// Magic-link delivery. Resend when a key is present, console otherwise, so
// local development needs no email account at all.
// ponytail: raw fetch, not the Resend SDK — it is one POST.

const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM || 'Skulpt <login@goskulpt.com>';

export async function sendMagicLink(email, link) {
  if (!KEY) {
    console.log(`\n  [dev] magic link for ${email}\n  ${link}\n`);
    return { delivered: 'console' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: email,
      subject: 'Your Skulpt sign-in link',
      text: `Sign in to Skulpt:\n\n${link}\n\nThis link works once and expires in 20 minutes.\nIf you did not ask for it, ignore this email.`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend refused the message (${res.status}): ${body.slice(0, 200)}`);
  }
  return { delivered: 'email' };
}
