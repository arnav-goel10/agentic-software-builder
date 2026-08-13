import { NextResponse } from "next/server";

const MESSAGE =
  "This one-shot endpoint has been removed. Use /api/projects -> /messages -> /runs for iterative execution.";

export async function POST() {
  return NextResponse.json(
    {
      error: "Endpoint removed",
      message: MESSAGE,
      success: false,
    },
    { status: 410 }
  );
}
