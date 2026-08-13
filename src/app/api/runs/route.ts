import { NextResponse } from "next/server";
import { listRecentRuns } from "@/lib/server/repositories";

export async function GET() {
  const runs = listRecentRuns(100);
  return NextResponse.json({ runs });
}
