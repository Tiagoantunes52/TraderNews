// Thin Resend wrapper using fetch (no SDK dependency, matching the fetch-based
// style of the other integrations). Sends are no-ops when unconfigured so the
// pipeline degrades gracefully in dev/CI.

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export type SendResult = { ok: boolean; error?: string };

export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.ALERT_FROM_EMAIL;
}

export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERT_FROM_EMAIL;
  if (!apiKey || !from) return { ok: false, error: "Email not configured" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      ...(msg.text ? { text: msg.text } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `Resend ${res.status}: ${body}` };
  }
  return { ok: true };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build a digest email body from a batch of alerts for a single recipient.
 * Pure — returns subject/html/text without sending.
 */
export function buildAlertEmail(
  alerts: { title: string; message: string }[]
): { subject: string; html: string; text: string } {
  const count = alerts.length;
  const subject =
    count === 1 ? `TraderNews alert: ${alerts[0].title}` : `TraderNews: ${count} new alerts`;

  const items = alerts
    .map(
      (a) =>
        `<li style="margin:0 0 12px 0"><strong style="display:block;font-size:14px">${escapeHtml(
          a.title
        )}</strong><span style="color:#475569;font-size:13px">${escapeHtml(a.message)}</span></li>`
    )
    .join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto">
  <h2 style="font-size:18px;margin:0 0 4px">📈 TraderNews</h2>
  <p style="color:#64748b;font-size:13px;margin:0 0 16px">${
    count === 1 ? "1 watchlist alert" : `${count} watchlist alerts`
  }</p>
  <ul style="list-style:none;padding:0;margin:0">${items}</ul>
  <p style="color:#94a3b8;font-size:12px;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:12px">
    You receive these because alert emails are enabled. Turn them off in TraderNews → Settings.
  </p>
</div>`;

  const text =
    `TraderNews — ${count === 1 ? "1 alert" : `${count} alerts`}\n\n` +
    alerts.map((a) => `• ${a.title}\n  ${a.message}`).join("\n\n") +
    `\n\nManage alert emails in TraderNews → Settings.`;

  return { subject, html, text };
}
