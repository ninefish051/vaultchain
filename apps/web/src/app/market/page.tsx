"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Search, SlidersHorizontal } from "lucide-react";
import { Sheet } from "@/components/Sheet";
import { api } from "@/lib/api";
import { CardTypeTile, ListingTile } from "@/components/CardTile";
import { Empty, PageHeader, Spinner } from "@/components/ui";

const SORTS = [
  { v: "price_desc", l: "Price: high to low" },
  { v: "price_asc", l: "Price: low to high" },
  { v: "change_desc", l: "Biggest gainers" },
  { v: "change_asc", l: "Biggest decliners" },
  { v: "name", l: "Name" },
];

function Market() {
  const params = useSearchParams();
  const [view, setView] = useState<"listings" | "cards">(params.get("view") === "cards" ? "cards" : "listings");
  const [q, setQ] = useState(params.get("q") ?? "");
  const [grader, setGrader] = useState("");
  const [grade, setGrade] = useState("");
  const [type, setType] = useState("");
  const [swapOnly, setSwapOnly] = useState(false);
  const [sort, setSort] = useState("price_desc");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = [grader, grade, type, swapOnly ? "swap" : ""].filter(Boolean).length;

  const cards = useQuery({ queryKey: ["cards", q, grader, grade, sort], queryFn: () => api.cards({ q, grader, grade, sort }) });
  const listings = useQuery({
    queryKey: ["listings", type, swapOnly],
    queryFn: () => api.listings({ type: type || undefined, acceptsSwap: swapOnly ? "true" : undefined }),
  });

  const text = q.trim().toLowerCase();
  const shownListings = (listings.data ?? [])
    .filter((l) => !text || `${l.card.name} ${l.card.setName} ${l.card.grader} ${l.card.grade}`.toLowerCase().includes(text))
    .filter((l) => (!grader || l.card.grader === grader) && (!grade || l.card.grade === grade))
    .sort((a, b) =>
      sort === "price_asc" ? a.priceUsd - b.priceUsd : sort === "name" ? a.card.name.localeCompare(b.card.name) : b.priceUsd - a.priceUsd,
    );

  return (
    <div className="container-page">
      <PageHeader title="Market" sub="Vault listings settle instantly as NFTs. Escrow listings are still with the seller and go through deposit, shipping and vault inspection." />

      {/* the same filter controls render inline on desktop and in a bottom sheet on phones */}
      {(() => {
        const controls = (
          <>
            <select className="input lg:w-32" value={grader} onChange={(e) => setGrader(e.target.value)}>
              <option value="">All graders</option>
              <option>PSA</option>
              <option>BGS</option>
              <option>CGC</option>
            </select>
            <select className="input lg:w-28" value={grade} onChange={(e) => setGrade(e.target.value)}>
              <option value="">Any grade</option>
              {["10", "9.5", "9", "8"].map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
            {view === "listings" && (
              <>
                <select className="input lg:w-36" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">Vault + escrow</option>
                  <option value="vault">Vault only</option>
                  <option value="escrow">Escrow only</option>
                </select>
                <label className="flex shrink-0 items-center gap-2 px-2 py-2 text-sm text-neutral-300">
                  <input type="checkbox" checked={swapOnly} onChange={(e) => setSwapOnly(e.target.checked)} className="h-4 w-4 accent-gold" /> Accepts swap
                </label>
              </>
            )}
            <select className="input lg:w-44" value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map((s) => (
                <option key={s.v} value={s.v}>
                  {s.l}
                </option>
              ))}
            </select>
          </>
        );
        return (
          <>
            <div className="mt-6 flex gap-2 lg:panel lg:items-center lg:gap-3 lg:p-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-3 h-4 w-4 text-neutral-500" />
                <input className="input pl-9" placeholder="Search Charizard, Base Set, PSA 10…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <button className="btn-ghost shrink-0 lg:hidden" onClick={() => setFiltersOpen(true)} aria-label="Filters">
                <SlidersHorizontal className="h-4 w-4" />
                {activeFilters > 0 && <span className="rounded-full bg-gold px-1.5 text-[10px] text-ink-900">{activeFilters}</span>}
              </button>
              <div className="hidden gap-3 lg:flex lg:items-center">{controls}</div>
            </div>
            <Sheet open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filter & sort">
              <div className="grid gap-3">{controls}</div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setGrader("");
                    setGrade("");
                    setType("");
                    setSwapOnly(false);
                  }}
                >
                  Reset
                </button>
                <button className="btn-gold" onClick={() => setFiltersOpen(false)}>
                  Show results
                </button>
              </div>
            </Sheet>
          </>
        );
      })()}

      <div className="mt-6 flex gap-2">
        {(["listings", "cards"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)} className={`rounded-lg px-3 py-1.5 text-sm ${view === v ? "bg-gold text-ink-900" : "bg-ink-700 text-neutral-300"}`}>
            {v === "listings" ? `For sale (${shownListings.length})` : `Card prices (${cards.data?.length ?? 0})`}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {view === "listings" ? (
          listings.isLoading ? (
            <Spinner />
          ) : shownListings.length === 0 ? (
            <Empty title="No listings match">Try another grade or turn off filters.</Empty>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              {shownListings.map((l) => (
                <ListingTile key={l.id} l={l} />
              ))}
            </div>
          )
        ) : cards.isLoading ? (
          <Spinner />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {(cards.data ?? []).map((c) => (
              <CardTypeTile key={c.cardKey} c={c} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function MarketPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Market />
    </Suspense>
  );
}
