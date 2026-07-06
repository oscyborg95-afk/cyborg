import type { Metadata } from "next";
import { Baloo_2, Nunito } from "next/font/google";
import "./globals.css";
import { NavTabs } from "./nav-tabs";
import { LevelBadge } from "./level-badge";
import { Froggy } from "./components/froggy";

const baloo = Baloo_2({
  variable: "--font-baloo",
  subsets: ["latin"],
});

const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Daily Cart — Command Center",
  description: "A gamified WhatsApp COD command center",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${baloo.variable} ${nunito.variable} h-full antialiased`}>
      <body className="flex h-screen flex-col overflow-hidden">
        <nav className="z-20 flex shrink-0 items-center gap-4 border-b-2 border-cardline bg-white/80 px-4 py-2 backdrop-blur">
          <div className="flex items-center gap-2">
            <Froggy mood="happy" size={38} bob={false} />
            <span className="font-display text-lg font-extrabold tracking-tight text-frog-dark">
              Daily&nbsp;Cart
            </span>
          </div>
          <NavTabs />
          <div className="ml-auto">
            <LevelBadge />
          </div>
        </nav>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </body>
    </html>
  );
}
