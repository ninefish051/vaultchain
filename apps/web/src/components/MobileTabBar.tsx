"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftRight, Bot, LayoutGrid, Tag, User } from "lucide-react";

const TABS = [
  { href: "/market", label: "Market", icon: LayoutGrid, match: ["/market", "/cards", "/listings"] },
  { href: "/swap", label: "Swap", icon: ArrowLeftRight, match: ["/swap"] },
  { href: "/sell", label: "Sell", icon: Tag, match: ["/sell"] },
  { href: "/agent", label: "Agent", icon: Bot, match: ["/agent"] },
  { href: "/me", label: "Me", icon: User, match: ["/me", "/orders", "/swaps", "/assets", "/vault"] },
];

/** Bottom navigation on phones (hidden from md up, where the header nav shows). */
export function MobileTabBar() {
  const path = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-600 bg-ink-900/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <div className="grid h-16 grid-cols-5">
        {TABS.map((t) => {
          const active = t.match.some((m) => path.startsWith(m));
          return (
            <Link key={t.href} href={t.href} className={`flex flex-col items-center justify-center gap-1 text-[11px] font-medium ${active ? "text-gold" : "text-neutral-400"}`}>
              <t.icon className="h-5 w-5" />
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * A bar pinned above the tab bar on phones for the page's main action, so it is always reachable.
 * On desktop it renders nothing (the action lives in the page).
 */
export function MobileActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t border-ink-600 bg-ink-800/95 px-4 py-3 backdrop-blur md:hidden">
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}
