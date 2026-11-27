"use client";

import { useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PricePointSeries } from "@vaultchain/shared";
import { usd } from "@/lib/format";

const RANGES = [7, 30, 90] as const;

export function PriceChart({ history }: { history: PricePointSeries[] }) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const data = history.slice(-days);
  const first = data[0]?.fairValueUsd ?? 0;
  const last = data.at(-1)?.fairValueUsd ?? 0;
  const up = last >= first;
  const color = up ? "#3FBF7F" : "#E5484D";
  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-medium">Fair value</div>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setDays(r)}
              className={`rounded-lg px-2.5 py-1 text-xs ${days === r ? "bg-gold text-ink-900" : "text-neutral-400 hover:text-white"}`}
            >
              {r}D
            </button>
          ))}
        </div>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <defs>
              <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="date" tick={{ fill: "#8a8a93", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={40} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fill: "#8a8a93", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(v: number) => usd(v)}
            />
            <Tooltip
              contentStyle={{ background: "#131315", border: "1px solid #3A3A40", borderRadius: 12, fontSize: 12 }}
              labelStyle={{ color: "#bbb" }}
              formatter={(v) => [usd(Number(v), true), "Fair value"]}
            />
            <Area type="monotone" dataKey="fairValueUsd" stroke={color} strokeWidth={2} fill="url(#fill)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
