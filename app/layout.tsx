import type { Metadata } from "next";
import { Baloo_2, Nunito } from "next/font/google";
import "./globals.css";
import { NavTabs } from "./nav-tabs";
import { LevelBadge } from "./level-badge";
import { Froggy } from "./components/froggy";
import { ThemeToggle } from "./theme-toggle";

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
        <nav className="z-20 flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b-2 border-cardline bg-surface/80 px-3 py-2 backdrop-blur sm:gap-3 sm:px-4">
          <div className="flex items-center gap-2">
            <Froggy mood="happy" size={38} bob={false} />
            <span className="font-display text-lg font-extrabold tracking-tight text-frog-dark">
              Daily&nbsp;Cart
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2 md:order-last md:ml-0">
            <ThemeToggle />
            <div className="hidden md:block"><LevelBadge /></div>
          </div>
          <NavTabs />
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</div>
      </body>
    </html>
  );
}
