import type { ReactNode } from "react";

/**
 * `/voicelink` is a fully client-driven dashboard that talks to the local AI
 * backend at runtime. It must not be statically prerendered: under Next 15.5 the
 * static-prerender pass throws inside the webpack server runtime for this
 * client-only route, which fails `next build`. Forcing the segment dynamic keeps
 * the page's behaviour identical (it already fetches everything at runtime) while
 * skipping the broken prerender step. No functionality is changed.
 */
export const dynamic = "force-dynamic";

export default function VoiceLinkLayout({ children }: { children: ReactNode }) {
  return children;
}
