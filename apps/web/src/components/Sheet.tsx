"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

/** Bottom sheet for phones (filters, forms). Closes on backdrop tap or Escape. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl border-t border-ink-600 bg-ink-800 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink-500" />
        <div className="mb-4 flex items-center justify-between">
          <div className="text-base font-semibold">{title}</div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-neutral-400 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
