"use client";

import Link from "next/link";
import { ChevronRight, ClipboardList, Gem, Shield, Wallet } from "lucide-react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { Credits } from "@/components/Credits";
import { PageHeader } from "@/components/ui";

const LINKS = [
  { href: "/orders", label: "Orders & swaps", sub: "Signatures waiting, offers, escrow progress", icon: ClipboardList },
  { href: "/assets", label: "My vault", sub: "Cards held as NFTs, redeem or resell", icon: Gem },
  { href: "/vault", label: "Vault operations", sub: "Staff only: intake, inspection, delivery", icon: Shield },
];

/** Phone "Me" tab: wallet, balance to withdraw, and links to orders, assets and vault tools. */
export default function MePage() {
  const { isConnected } = useAccount();
  return (
    <div className="container-page">
      <PageHeader title="Me" />
      <div className="panel mt-6 flex items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3">
          <Wallet className="h-5 w-5 text-gold" />
          <span className="text-sm text-neutral-300">{isConnected ? "Wallet connected" : "Connect a wallet to trade"}</span>
        </div>
        <ConnectButton label="Connect" chainStatus="icon" showBalance={false} accountStatus="avatar" />
      </div>
      <Credits />
      <div className="panel mt-6 divide-y divide-ink-700">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="flex items-center gap-3 px-4 py-4">
            <l.icon className="h-5 w-5 text-gold" />
            <div className="flex-1">
              <div className="font-medium">{l.label}</div>
              <div className="text-xs text-neutral-500">{l.sub}</div>
            </div>
            <ChevronRight className="h-4 w-4 text-neutral-500" />
          </Link>
        ))}
      </div>
    </div>
  );
}
