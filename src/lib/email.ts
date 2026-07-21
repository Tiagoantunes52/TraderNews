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

const SEVERITY_STYLE: Record<string, { label: string; color: string }> = {
  fail: { label: "FAIL", color: "#dc2626" },
  warn: { label: "WARN", color: "#d97706" },
  info: { label: "INFO", color: "#2563eb" },
};

const STATUS_LINE: Record<string, string> = {
  OK: "Everything behaved as the rules say it should.",
  WARN: "The books traded, but some checks want a look.",
  FAIL: "At least one check found the app doing something its own rules forbid.",
};

/**
 * Build the daily post-close review email. Pure — returns subject/html/text
 * without sending. Leads with the verdict and the failures, because on a normal
 * day this email should be glanceable in five seconds and only ever demand
 * attention when something actually broke.
 */
export function buildReviewEmail(report: {
  date: string;
  status: string;
  summary: {
    findings: number;
    fails: number;
    warns: number;
    openPositions: number;
    openedToday: number;
    closedToday: number;
    realizedToday: number;
  };
  findings: { severity: string; code: string; title: string; detail: string }[];
  notes: string[];
}): { subject: string; html: string; text: string } {
  const { summary } = report;
  const badge = report.status === "OK" ? "✅" : report.status === "WARN" ? "⚠️" : "🚨";
  const subject =
    summary.fails > 0
      ? `TraderNews review ${report.date}: ${summary.fails} failure${summary.fails === 1 ? "" : "s"}`
      : summary.warns > 0
        ? `TraderNews review ${report.date}: ${summary.warns} warning${summary.warns === 1 ? "" : "s"}`
        : `TraderNews review ${report.date}: all clear`;

  const money = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;
  const activity = `${summary.openedToday} opened · ${summary.closedToday} closed · ${money(
    summary.realizedToday
  )} realized · ${summary.openPositions} open`;

  // Only the actionable severities go in the body; the tuning notes are numerous
  // and belong in the dashboard, not in a mail that must stay skimmable.
  const shown = report.findings.filter((f) => f.severity !== "info").slice(0, 25);
  const items = shown
    .map((f) => {
      const s = SEVERITY_STYLE[f.severity] ?? SEVERITY_STYLE.info;
      return `<li style="margin:0 0 14px 0">
    <span style="display:inline-block;font-size:11px;font-weight:600;color:${s.color};letter-spacing:.04em">${s.label}</span>
    <strong style="display:block;font-size:14px;margin:2px 0">${escapeHtml(f.title)}</strong>
    <span style="color:#475569;font-size:13px">${escapeHtml(f.detail)}</span>
  </li>`;
    })
    .join("");

  const infoCount = report.findings.length - shown.length;
  const body = shown.length
    ? `<ul style="list-style:none;padding:0;margin:0">${items}</ul>`
    : `<p style="color:#475569;font-size:13px;margin:0">Nothing needs attention today.</p>`;

  const notesHtml = report.notes.length
    ? `<p style="color:#94a3b8;font-size:12px;margin:16px 0 0">${report.notes
        .map((n) => escapeHtml(n))
        .join("<br>")}</p>`
    : "";

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto">
  <h2 style="font-size:18px;margin:0 0 4px">${badge} TraderNews daily review</h2>
  <p style="color:#64748b;font-size:13px;margin:0 0 4px">${report.date} — ${escapeHtml(
    STATUS_LINE[report.status] ?? ""
  )}</p>
  <p style="color:#64748b;font-size:12px;margin:0 0 16px">${activity}</p>
  ${body}
  ${infoCount > 0 ? `<p style="color:#94a3b8;font-size:12px;margin:16px 0 0">+ ${infoCount} informational finding${infoCount === 1 ? "" : "s"} (tuning signals) on the dashboard.</p>` : ""}
  ${notesHtml}
  <p style="color:#94a3b8;font-size:12px;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:12px">
    Sent because you're an admin with alert emails on. Turn them off in TraderNews → Settings.
  </p>
</div>`;

  const text =
    `TraderNews daily review — ${report.date} [${report.status}]\n${STATUS_LINE[report.status] ?? ""}\n${activity}\n\n` +
    (shown.length
      ? shown.map((f) => `[${(SEVERITY_STYLE[f.severity] ?? SEVERITY_STYLE.info).label}] ${f.title}\n  ${f.detail}`).join("\n\n")
      : "Nothing needs attention today.") +
    (infoCount > 0 ? `\n\n+ ${infoCount} informational finding(s) on the dashboard.` : "") +
    (report.notes.length ? `\n\n${report.notes.join("\n")}` : "");

  return { subject, html, text };
}
