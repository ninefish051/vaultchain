/** PSA public cert API: certificate number → card details (verification, not pricing). */
export interface PsaCert {
  certNumber: string;
  year?: string;
  brand?: string;
  subject?: string;
  variety?: string;
  cardNumber?: string;
  grade?: string;
  gradeDescription?: string;
  totalPopulation?: number;
}

export async function lookupPsaCert(cert: string): Promise<PsaCert | undefined> {
  const token = process.env.PSA_API_TOKEN;
  if (!token) throw Object.assign(new Error("PSA_API_TOKEN is not configured"), { statusCode: 501 });
  const r = await fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(cert)}`, {
    headers: { Authorization: `bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 404) return undefined;
  if (!r.ok) throw Object.assign(new Error(`PSA API ${r.status}`), { statusCode: 502 });
  const j = (await r.json()) as { PSACert?: Record<string, unknown> };
  const c = j.PSACert;
  if (!c) return undefined;
  const s = (k: string) => (c[k] === undefined || c[k] === null ? undefined : String(c[k]));
  return {
    certNumber: s("CertNumber") ?? cert,
    year: s("Year"),
    brand: s("Brand"),
    subject: s("Subject"),
    variety: s("Variety"),
    cardNumber: s("CardNumber"),
    grade: s("CardGrade")?.match(/[\d.]+/)?.[0],
    gradeDescription: s("GradeDescription"),
    totalPopulation: c.TotalPopulation === undefined ? undefined : Number(c.TotalPopulation),
  };
}
