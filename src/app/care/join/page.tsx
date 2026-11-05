import type { Metadata } from "next";
import PatientJoin from "@/components/care/PatientJoin";

export const metadata: Metadata = {
  title: "Join your care session — CareSpeak",
  description: "Join a secure CareSpeak browser voice session.",
};

export default async function CareJoinPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const params = await searchParams;
  return <PatientJoin token={params.t ?? null} />;
}
