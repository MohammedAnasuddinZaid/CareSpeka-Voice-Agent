import type { Metadata } from "next";
import BrowserCall from "@/components/care/PhoneCall";

export const metadata: Metadata = {
  title: "Free browser call — CareSpeak",
  description: "Talk to the CareSpeak care agent in your browser. No phone charges.",
};

export default async function CarePhonePage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string; pair?: string }>;
}) {
  const params = await searchParams;
  return (
    <main className="min-h-screen bg-[#faf7f5] px-3 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-4 flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#c63a22] text-sm font-black text-white">
            CS
          </span>
          <div>
            <p className="text-sm font-bold text-[#1f1f1f]">CareSpeak</p>
            <p className="text-[11px] text-[#6e6e6e]">Free browser call · no phone charges</p>
          </div>
        </header>

        <BrowserCall sessionId={params.session ?? ""} pair={params.pair ?? null} />

        <p className="mx-auto mt-5 max-w-lg text-center text-[11px] leading-relaxed text-[#8a8a8a]">
          The CareSpeak agent answers using this patient&apos;s care record and live readings. This demo call
          is not a medical device and does not replace clinical judgement.
        </p>
      </div>
    </main>
  );
}
