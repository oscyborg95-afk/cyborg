import { NextResponse } from "next/server";
import { listOrderNotifications } from "@/lib/db";

export const dynamic = "force-dynamic";

// Message audit for one order: what we sent, when, to whom, and why it was or
// was not sent. Fetched on demand from the delivery rescue card.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const notifications = await listOrderNotifications(id);
    return NextResponse.json({ notifications });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not load the message history",
      },
      { status: 500 }
    );
  }
}
