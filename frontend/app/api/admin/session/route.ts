import { NextResponse } from "next/server";

import { getSessionFromCookies } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionFromCookies();

  if (!session) {
    return NextResponse.json({ authenticated: false });
  }

  return NextResponse.json({
    authenticated: true,
    login_id: session.loginId,
    crews: session.crews,
  });
}
