"use client";

import { useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Menu, X, Hand, Eye, Activity, FileText, Info, AlertTriangle, Camera, ClipboardList, BedDouble, LayoutDashboard } from "lucide-react";
import { SUPPORTED_LANGUAGES, SupportedLanguage } from "@/types";
import { voiceAlert } from "@/lib/tts";
import { t, type UIKey } from "@/lib/i18n";
import { useUiLanguage } from "@/hooks/useUiLanguage";

type NavItem = { href: string; label: string; i18nKey?: UIKey; icon: typeof Hand; description?: string };
type NavGroup = { label: string; icon: typeof Hand; items: NavItem[] };

// A short, uncluttered structure: a few top-level groups, plus About and a
// prominent Emergency button. Nothing is hidden that was there before.
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Care",
    icon: Activity,
    items: [
      { href: "/hand-mode", label: "Hand Mode", i18nKey: "handMode", icon: Hand, description: "Gesture to speech" },
      { href: "/eye-mode", label: "Eye Mode", i18nKey: "eyeMode", icon: Eye, description: "Eye-tracking input" },
      { href: "/nurse-view", label: "Nurse Dashboard", i18nKey: "nurse", icon: Activity },
      { href: "/care/records", label: "Patient Records", icon: FileText, description: "History for the AI assistant" },
      { href: "/ward", label: "Ward", i18nKey: "ward", icon: BedDouble },
      { href: "/cctv", label: "CCTV", i18nKey: "cctv", icon: Camera },
    ],
  },
  {
    label: "Records",
    icon: ClipboardList,
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/logs", label: "Gesture Logs", i18nKey: "logs", icon: FileText },
      { href: "/report", label: "Clinical Report", i18nKey: "report", icon: ClipboardList },
    ],
  },
];

const ABOUT: NavItem = { href: "/about", label: "About", i18nKey: "about", icon: Info };
const EMERGENCY: NavItem = { href: "/emergency", label: "Emergency", i18nKey: "emergency", icon: AlertTriangle };

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const navRef = useRef<HTMLElement | null>(null);
  // Reactive: switching language re-renders every nav label instantly.
  const currentLang = useUiLanguage();
  const currentLangInfo = SUPPORTED_LANGUAGES[currentLang];
  const isLanding = pathname === "/";
  const label = (item: NavItem): string => (item.i18nKey ? t(currentLang, item.i18nKey) : item.label);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close any open dropdown when tapping/clicking outside the nav.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpenGroup(null);
        setLangOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const handleLanguageChange = (lang: SupportedLanguage) => {
    voiceAlert.setLanguage(lang);
    setLangOpen(false);
  };

  const showSolid = scrolled || !isLanding;
  const groupActive = (g: NavGroup) => g.items.some((i) => i.href === pathname);

  const topButtonClass = (active: boolean) =>
    `flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${
      active
        ? "bg-[#c63a22]/10 text-[#c63a22]"
        : showSolid
        ? "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]"
        : "text-white/70 hover:text-white hover:bg-white/10"
    }`;

  const emergencyClass = showSolid
    ? "text-[#c63a22] hover:bg-[#c63a22]/5"
    : "text-white hover:bg-white/10";

  return (
    <nav ref={navRef} className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
      showSolid ? "nav-solid" : "nav-transparent"
    }`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <a href="/" className="flex items-center gap-2.5 shrink-0 group">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center transition-all duration-200 group-hover:shadow-md group-hover:shadow-[#c63a22]/20 overflow-hidden">
              <img src="/logo.png" alt="CareSpeak" className="w-full h-full object-cover" />
            </div>
            <div className="hidden sm:block">
              <span className={`font-bold text-lg tracking-tight transition-colors duration-300 ${showSolid ? "text-[#1f1f1f]" : "text-white"}`}>
                CareSpeak
              </span>
            </div>
          </a>

          <div className="hidden lg:flex items-center gap-1">
            {NAV_GROUPS.map((group) => {
              const Icon = group.icon;
              const active = groupActive(group);
              return (
                <div
                  key={group.label}
                  className="relative"
                  onMouseEnter={() => setOpenGroup(group.label)}
                  onMouseLeave={() => setOpenGroup((g) => (g === group.label ? null : g))}
                >
                  <button
                    type="button"
                    aria-haspopup="true"
                    aria-expanded={openGroup === group.label}
                    onClick={() => setOpenGroup((g) => (g === group.label ? null : group.label))}
                    className={topButtonClass(active)}
                  >
                    <Icon className="w-4 h-4" />
                    {group.label}
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${openGroup === group.label ? "rotate-180" : ""}`} />
                  </button>
                  <AnimatePresence>
                    {openGroup === group.label && (
                      <motion.div
                        initial={{ opacity: 0, y: -6, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.98 }}
                        transition={{ duration: 0.15 }}
                        className="absolute left-0 top-full mt-1 w-64 rounded-2xl bg-white border border-[#ececec] shadow-lg shadow-black/5 py-2 z-50"
                      >
                        {group.items.map((item) => {
                          const ItemIcon = item.icon;
                          const isActive = pathname === item.href;
                          return (
                            <a
                              key={item.href}
                              href={item.href}
                              onClick={() => setOpenGroup(null)}
                              className={`flex items-start gap-3 px-4 py-2.5 transition-colors ${
                                isActive ? "bg-[#c63a22]/5 text-[#c63a22]" : "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]"
                              }`}
                            >
                              <ItemIcon className="mt-0.5 w-4 h-4 shrink-0" />
                              <span>
                                <span className="block text-sm font-medium">{label(item)}</span>
                                {item.description ? <span className="block text-xs text-[#9ca3af]">{item.description}</span> : null}
                              </span>
                            </a>
                          );
                        })}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}

            <a href={ABOUT.href} className={topButtonClass(pathname === ABOUT.href)}>
              <Info className="w-4 h-4" />
              {label(ABOUT)}
            </a>
            <a href={EMERGENCY.href} className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold transition-all duration-200 ${emergencyClass}`}>
              <AlertTriangle className="w-4 h-4" />
              {label(EMERGENCY)}
            </a>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                onClick={() => setLangOpen(!langOpen)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm transition-all duration-200 ${
                  showSolid ? "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]" : "text-white/70 hover:text-white hover:bg-white/10"
                }`}
              >
                <span className="text-sm">{currentLangInfo.native}</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${langOpen ? "rotate-180" : ""}`} />
              </button>
              <AnimatePresence>
                {langOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -8, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.96 }}
                    className="absolute right-0 top-full mt-2 w-48 rounded-2xl bg-white border border-[#ececec] shadow-lg shadow-black/5 py-2 z-50"
                  >
                    {(Object.entries(SUPPORTED_LANGUAGES) as [SupportedLanguage, { label: string; native: string }][]).map(([code, info]) => (
                      <button key={code} onClick={() => handleLanguageChange(code)}
                        className={`w-full text-left px-4 py-2.5 text-sm transition-colors flex items-center gap-2 ${
                          currentLang === code ? "text-[#c63a22] bg-[#c63a22]/5 font-medium" : "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]"
                        }`}
                      >
                        <span>{info.native}</span>
                        <span className="text-[#9ca3af] text-xs">{info.label}</span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <button
              onClick={() => setOpen(!open)}
              className={`lg:hidden p-2 rounded-xl transition-all duration-200 ${
                showSolid ? "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]" : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="lg:hidden border-t border-[#ececec] bg-white max-h-[80vh] overflow-y-auto"
          >
            <div className="px-4 py-3 space-y-1">
              {NAV_GROUPS.map((group) => (
                <div key={group.label} className="pt-2">
                  <div className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-widest text-[#9ca3af]">{group.label}</div>
                  {group.items.map((item) => {
                    const ItemIcon = item.icon;
                    const isActive = pathname === item.href;
                    return (
                      <a
                        key={item.href}
                        href={item.href}
                        onClick={() => setOpen(false)}
                        className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                          isActive ? "bg-[#c63a22]/10 text-[#c63a22]" : "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]"
                        }`}
                      >
                        <ItemIcon className="w-4 h-4" />
                        {label(item)}
                      </a>
                    );
                  })}
                </div>
              ))}
              <div className="pt-2 border-t border-[#f1f1f1] mt-2">
                <a
                  href={ABOUT.href}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    pathname === ABOUT.href ? "bg-[#c63a22]/10 text-[#c63a22]" : "text-[#6e6e6e] hover:text-[#1f1f1f] hover:bg-[#f5f3f0]"
                  }`}
                >
                  <Info className="w-4 h-4" />
                  {label(ABOUT)}
                </a>
                <a
                  href={EMERGENCY.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-semibold text-[#c63a22] hover:bg-[#c63a22]/5"
                >
                  <AlertTriangle className="w-4 h-4" />
                  {label(EMERGENCY)}
                </a>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}
