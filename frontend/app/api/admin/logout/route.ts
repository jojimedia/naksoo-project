import { NextResponse } from "next/server";

import { getClearSessionCookieOptions } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

export async function POST() {
  const response = NextResponse.json({ ok: true });

  response.cookies.set({
    ...getClearSessionCookieOptions(),
    value: "",
  });

  return response;
}
