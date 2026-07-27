import type { Metadata } from "next";
import { Baloo_2, Nunito } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { NavTabs } from "./nav-tabs";
import { LevelBadge } from "./level-badge";
import { Froggy } from "./components/froggy";
import { ThemeToggle } from "./theme-toggle";
import { WhatsAppAccountControl } from "./whatsapp-account-control";

const themeBootstrap = `(function(){try{var t=localStorage.getItem('daily-cart-theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}})()`;

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
    <html lang="en" suppressHydrationWarning className={`${baloo.variable} ${nunito.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="flex h-dvh min-w-0 flex-col overflow-hidden">
        <header className="z-20 flex min-w-0 shrink-0 items-center justify-between gap-3 border-b-2 border-cardline bg-surface/90 px-3 py-2.5 backdrop-blur-md sm:px-4">
          {/* Left: Brand Identity & Level Badge */}
          <div className="flex items-center gap-2.5 shrink-0">
            <Link
              href="/"
              className="flex items-center gap-2 rounded-xl transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-frog"
            >
              <Froggy mood="happy" size={36} bob={false} />
              <span className="font-display text-lg font-extrabold tracking-tight text-frog-dark">
                Daily&nbsp;Cart
              </span>
            </Link>
            <div className="hidden xl:block ml-1">
              <LevelBadge />
            </div>
          </div>

          {/* Navigation Links */}
          <NavTabs />

          {/* Right Utility Cluster */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden md:block xl:hidden">
              <LevelBadge />
            </div>
            <WhatsAppAccountControl />
            <ThemeToggle />
          </div>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </body>
    </html>
  );
}
