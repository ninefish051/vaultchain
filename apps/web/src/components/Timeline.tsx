import { Check } from "lucide-react";

/** Horizontal step indicator for an order or swap. */
export function Timeline({ steps, current, failed }: { steps: string[]; current: number; failed?: string }) {
  return (
    <div className="panel p-5">
      <ol className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-y-4">
        {steps.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={s} className="flex items-center gap-2 sm:min-w-[120px] sm:flex-1">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                  done ? "border-gold bg-gold text-ink-900" : active ? "border-gold text-gold" : "border-ink-500 text-neutral-500"
                }`}
              >
                {done ? <Check className="h-4 w-4" /> : i + 1}
              </span>
              <span className={`text-sm ${active ? "text-white" : done ? "text-neutral-300" : "text-neutral-500"}`}>{s}</span>
              {i < steps.length - 1 && <span className="mx-2 hidden h-px flex-1 bg-ink-600 sm:block" />}
            </li>
          );
        })}
      </ol>
      {failed && <div className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{failed}</div>}
    </div>
  );
}
