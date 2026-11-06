import type { Metadata } from "next";
import RecordsIntake from "@/components/care/RecordsIntake";

export const metadata: Metadata = {
  title: "Patient records — CareSpeak",
  description: "Insert previous patient records so the nurse-portal assistant has full history.",
};

export default function CareRecordsPage() {
  return <RecordsIntake />;
}