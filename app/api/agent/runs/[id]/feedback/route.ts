import { NextRequest, NextResponse } from "next/server";
import { reviewAgentDraft, type DraftReviewAction } from "@/lib/agent-review";

const ACTIONS = new Set<DraftReviewAction>(["approve", "edit", "reject"]);

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const body = await req.json();
  const action = body.action as DraftReviewAction;
  if (!ACTIONS.has(action)) {
    return NextResponse.json(
      { error: "action must be approve, edit, or reject" },
      { status: 400 }
    );
  }
  try {
    const run = await reviewAgentDraft({
      runId: id,
      action,
      text: typeof body.text === "string" ? body.text : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    return NextResponse.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not review draft";
    const conflict = message.includes("already reviewed");
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }
}
