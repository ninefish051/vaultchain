"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ArrowLeftRight, Gem, LayoutGrid, ReceiptText, Tag } from "lucide-react";
import { useAccount } from "wagmi";
import { useDeployment } from "@/lib/contracts";
import { TestFaucet } from "./TestFaucet"; // TESTNET ONLY — remove before mainnet

// The Agent page stays reachable at /agent but is not linked until the agent is enabled.
const NAV = [
  { href: "/market", label: "Market", icon: LayoutGrid },
  { href: "/swap", label: "Swap", icon: ArrowLeftRight },
  { href: "/sell", label: "Sell", icon: Tag },
  { href: "/orders", label: "Orders", icon: ReceiptText },
  { href: "/assets", label: "My cards", icon: Gem },
];

export function Header() {
  const path = usePathname();
  const { isConnected } = useAccount();
  const { deployment, chainId } = useDeployment();
  return (
    <header className="sticky top-0 z-40 border-b border-ink-600 bg-ink-900/85 backdrop-blur">
      <div className="container-page flex h-14 items-center gap-6 md:h-16">
        <Link href="/" className="flex items-center gap-2.5">
          <img src="/logo.svg" alt="" className="h-7 w-7 md:h-8 md:w-8" />
          <span className="text-lg font-bold tracking-tight">
            Vault<span className="text-gold">Chain</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                path.startsWith(n.href) ? "bg-ink-700 text-gold" : "text-neutral-300 hover:text-white"
              }`}
            >
              <n.icon className="h-4 w-4" />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto">
          <ConnectButton
            label="Connect"
            chainStatus={{ smallScreen: "none", largeScreen: "icon" }}
            showBalance={false}
            accountStatus={{ smallScreen: "avatar", largeScreen: "address" }}
          />
        </div>
      </div>
      {isConnected && !deployment && (
        <div className="border-t border-gold/30 bg-gold/10 py-2 text-center text-xs text-gold">
          VaultChain contracts are not deployed on this network (chain {chainId}). Browsing works; switch to HashKey Chain Testnet to trade.
        </div>
      )}
      <TestFaucet /> {/* TESTNET ONLY — remove before mainnet */}
    </header>
  );
}
