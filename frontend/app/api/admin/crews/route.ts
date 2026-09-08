import { NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import { addCrew, getAdmin, listRegisteredCrewNames } from "@/lib/operations-store";

export async function GET() { return NextResponse.json({ crews: await listRegisteredCrewNames() }); }
export async function POST(request: Request) {
  try {
    const session = await getSessionFromCookies();
    if (!session) return jsonError("로그인이 필요합니다.", 401);
    const admin = await getAdmin(session.loginId);
    if (!admin?.is_superadmin) return jsonError("최고 관리자만 크루를 추가할 수 있습니다.", 403);
    const body = await request.json() as { crew_name?: string; representative_name?: string };
    const crew = body.crew_name?.trim() ?? ""; const representative = body.representative_name?.trim() ?? "";
    if (!crew || !representative) return jsonError("크루명과 대표자명을 입력해주세요.");
    await addCrew(crew, representative);
    return NextResponse.json({ ok: true, crew_name: crew, representative_name: representative });
  } catch (error) { return jsonError(error instanceof Error ? error.message : "크루 추가에 실패했습니다.", 500); }
}
