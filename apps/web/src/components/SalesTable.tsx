import type { SaleRecord } from "@vaultchain/shared";
import { ago, sourceLabel, usd } from "@/lib/format";
import { Badge } from "./ui";

export function SalesTable({ sales }: { sales: SaleRecord[] }) {
  return (
    <div className="panel overflow-hidden">
      <div className="border-b border-ink-600 px-4 py-3 text-sm font-medium">Recent sales and asks across platforms</div>
      {/* phones */}
      <div className="max-h-96 divide-y divide-ink-700 overflow-y-auto sm:hidden">
        {sales.map((s, i) => (
          <div key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate">{sourceLabel(s.source)}</span>
                <Badge tone={s.kind === "sold" ? "up" : s.kind === "listing" ? "neutral" : "blue"}>{s.kind}</Badge>
              </div>
              <div className="text-xs text-neutral-500">
                {ago(s.observedAt)}
                {s.currency && s.currency !== "USD" ? ` · ${s.originalPrice?.toLocaleString()} ${s.currency}` : ""}
              </div>
            </div>
            <div className="shrink-0 font-medium">{usd(s.priceUsd, true)}</div>
          </div>
        ))}
      </div>
      <div className="hidden max-h-96 overflow-y-auto sm:block">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-ink-800 text-left text-xs uppercase text-neutral-500">
            <tr>
              <th className="px-4 py-2 font-medium">Source</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 text-right font-medium">Price (USD)</th>
              <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Original</th>
              <th className="px-4 py-2 text-right font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {sales.map((s, i) => (
              <tr key={i} className="border-t border-ink-700">
                <td className="px-4 py-2">
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer" className="hover:text-gold">
                      {sourceLabel(s.source)}
                    </a>
                  ) : (
                    sourceLabel(s.source)
                  )}
                </td>
                <td className="px-4 py-2">
                  <Badge tone={s.kind === "sold" ? "up" : s.kind === "listing" ? "neutral" : "blue"}>{s.kind}</Badge>
                </td>
                <td className="px-4 py-2 text-right font-medium">{usd(s.priceUsd, true)}</td>
                <td className="hidden px-4 py-2 text-right text-neutral-400 sm:table-cell">
                  {s.currency && s.currency !== "USD" ? `${s.originalPrice?.toLocaleString()} ${s.currency}` : ""}
                </td>
                <td className="px-4 py-2 text-right text-neutral-400">{ago(s.observedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
