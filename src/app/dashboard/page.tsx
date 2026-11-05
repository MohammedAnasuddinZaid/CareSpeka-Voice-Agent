import type { Metadata } from "next";
import DashboardShell from "@/components/dashboard/DashboardShell";

export const metadata: Metadata = {
  title: "VoiceLink Dashboard — CareSpeak",
  description:
    "Nurse and administrator console for patient · AI · nurse · family communication, escalations, provider settings and audit.",
};

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-[#f9f7f5] pt-24 pb-16">
      <DashboardShell />
    </div>
  );
}
