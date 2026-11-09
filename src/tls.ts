// Expiración de certificados TLS vía los logs de transparencia (crt.sh).
// Es la vía simple de la v1: no depende de nada más que un fetch.
// La vía avanzada (v2) es la Sockets API de Cloudflare para leer el
// certificado con un handshake TLS directo.

export interface CertInfo {
  issuer: string;
  expiresAt: number;
  daysLeft: number;
}

export async function checkCertExpiry(hostname: string): Promise<CertInfo | null> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(
      `https://crt.sh/?q=${encodeURIComponent(hostname)}&output=json`,
      { signal: ctrl.signal, headers: { accept: "application/json" } },
    );
    if (!r.ok) return null;
    const certs = (await r.json()) as { issuer_name: string; not_after: string }[];
    if (!certs.length) return null;
    const latest = certs
      .map((c) => ({ issuer: c.issuer_name, exp: new Date(c.not_after).getTime() }))
      .sort((a, b) => b.exp - a.exp)[0];
    return {
      issuer: latest.issuer,
      expiresAt: latest.exp,
      daysLeft: Math.round((latest.exp - Date.now()) / 86_400_000),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}
