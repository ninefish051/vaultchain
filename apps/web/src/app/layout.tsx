import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: { default: "VaultChain · Graded card marketplace", template: "%s · VaultChain" },
  description: "Buy, sell and swap graded trading cards with on-chain two-sided escrow, vault custody and multi-source fair prices.",
  icons: { icon: "/logo.svg" },
};

export const viewport: Viewport = { themeColor: "#0B0B0C" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans" style={{ ["--font-sans" as string]: "Inter, ui-sans-serif, system-ui, -apple-system, 'PingFang SC', sans-serif" }}>
        <Providers>
          <Header />
          <main className="pb-24">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
