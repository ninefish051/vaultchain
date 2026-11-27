"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MapPin } from "lucide-react";
import { useAccount, useSignMessage } from "wagmi";
import { api, type ShippingAddress, type ShippingTarget } from "@/lib/api";
import { errorMessage } from "@/lib/contracts";

const EMPTY: ShippingAddress = { name: "", phone: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "" };

/**
 * Collects the recipient's shipping address for an order, swap leg or redemption. The API encrypts
 * it at rest and only vault operators can read it. Calls `onSaved` after a successful save.
 */
export function ShippingForm({ target, targetId, title, onSaved }: { target: ShippingTarget; targetId: string; title?: string; onSaved?: () => void }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();
  const [a, setA] = useState<ShippingAddress>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const status = useQuery({
    queryKey: ["shipping", target, targetId, address],
    queryFn: () => api.shippingStatus(target, targetId, address!),
    enabled: !!address,
  });

  if (status.data?.submitted)
    return (
      <div className="flex items-center gap-2 rounded-xl border border-up/40 bg-up/5 px-3 py-2 text-sm text-up">
        <CheckCircle2 className="h-4 w-4" /> Shipping address on file (encrypted).
      </div>
    );

  const field = (k: keyof ShippingAddress, label: string, opts: { half?: boolean; optional?: boolean; type?: string; auto?: string } = {}) => (
    <div className={opts.half ? "col-span-1" : "col-span-2"}>
      <label className="label">
        {label}
        {opts.optional && <span className="normal-case text-neutral-500"> (optional)</span>}
      </label>
      <input className="input" type={opts.type ?? "text"} autoComplete={opts.auto} value={a[k] ?? ""} onChange={(e) => setA({ ...a, [k]: e.target.value })} />
    </div>
  );

  async function save() {
    if (!address) return;
    setBusy(true);
    setErr(undefined);
    try {
      const clean = Object.fromEntries(Object.entries(a).filter(([, v]) => v)) as unknown as ShippingAddress;
      await api.saveShipping({ target, targetId, address: clean }, address, signMessageAsync);
      await qc.invalidateQueries({ queryKey: ["shipping", target, targetId] });
      onSaved?.();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const complete = a.name && a.phone && a.line1 && a.city && a.postalCode && a.country;
  return (
    <div className="rounded-xl border border-ink-600 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <MapPin className="h-4 w-4 text-gold" /> {title ?? "Where should the vault ship your card?"}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {field("name", "Full name", { auto: "name" })}
        {field("phone", "Phone", { type: "tel", auto: "tel" })}
        {field("line1", "Address", { auto: "address-line1" })}
        {field("line2", "Apartment, unit", { optional: true, auto: "address-line2" })}
        {field("city", "City", { half: true, auto: "address-level2" })}
        {field("region", "State / region", { half: true, optional: true, auto: "address-level1" })}
        {field("postalCode", "Postal code", { half: true, auto: "postal-code" })}
        {field("country", "Country", { half: true, auto: "country-name" })}
      </div>
      <p className="mt-2 text-xs text-neutral-500">Encrypted and visible only to the vault team. Never stored on-chain.</p>
      <button className="btn-gold mt-3 w-full" disabled={!complete || busy || !address} onClick={save}>
        {busy ? "Saving…" : "Save address"}
      </button>
      {err && <div className="mt-2 text-xs text-down">{err}</div>}
    </div>
  );
}

/** The vault's receiving address, shown to anyone who must ship a slab in for inspection. */
export function VaultAddress() {
  const cfg = useQuery({ queryKey: ["config"], queryFn: () => api.config(), staleTime: 3_600_000 });
  return (
    <div className="rounded-xl border border-gold/40 bg-gold/5 p-3 text-sm">
      <div className="label text-gold">Ship your slab to</div>
      <div className="whitespace-pre-line">{cfg.data?.vaultShippingAddress ?? "…"}</div>
      <div className="mt-1 text-xs text-neutral-400">Pack the slab in a rigid case, insure the parcel, and keep the tracking number.</div>
    </div>
  );
}
