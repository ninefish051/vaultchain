import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { MobileTabBar } from "@/components/MobileTabBar";

export const metadata: Metadata = {
  title: { default: "VaultChain · Graded card marketplace", template: "%s · VaultChain" },
  description: "Buy, sell and swap graded trading cards with on-chain two-sided escrow, vault custody and multi-source fair prices.",
  icons: { icon: "/logo.svg" },
};

export const viewport: Viewport = { themeColor: "#0B0B0C", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans" style={{ ["--font-sans" as string]: "Inter, ui-sans-serif, system-ui, -apple-system, 'PingFang SC', sans-serif" }}>
        <Providers>
          <Header />
          {/* phones: leave room for the bottom tab bar (+ page action bar) */}
          <main className="pb-44 md:pb-24">{children}</main>
          <Footer />
          <MobileTabBar />
        </Providers>
      </body>
    </html>
  );
}
