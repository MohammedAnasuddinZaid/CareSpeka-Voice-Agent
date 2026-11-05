import type { Metadata } from "next";
import CareDashboard from "@/components/care/CareDashboard";

export const metadata: Metadata = {
  title: "Web Voice Call — Demo — CareSpeak",
  description: "Browser-to-browser AI care call demonstration for CareSpeak.",
};

export default function CarePage() {
  return <CareDashboard />;
}
