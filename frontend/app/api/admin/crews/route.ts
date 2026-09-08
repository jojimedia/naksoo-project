import { NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import { addCrew, addMember, deleteCrew, getAdmin, listPublicCrewNames } from "@/lib/operations-store";
import { requestCollectorRefresh } from "@/lib/ranking-cache";

export async function GET() { return NextResponse.json({ crews: await listPublicCrewNames() }); }
export async function POST(request: Request) {
  try {
    const session = await getSessionFromCookies();
    if (!session) return jsonError("로그인이 필요합니다.", 401);
    const admin = await getAdmin(session.loginId);
    if (!admin?.is_superadmin) return jsonError("최고 관리자만 크루를 추가할 수 있습니다.", 403);
    const body = await request.json() as { crew_name?: string; representative_name?: string; representative_user_id?: string };
    const crew = body.crew_name?.trim() ?? ""; const representative = body.representative_name?.trim() ?? "";
    if (!crew || !representative) return jsonError("크루명과 대표자명을 입력해주세요.");
    await addCrew(crew, representative);
    if (body.representative_user_id?.trim()) {
      await addMember(crew, body.representative_user_id.trim(), representative);
    }
    await requestCollectorRefresh(session.loginId);
    return NextResponse.json({ ok: true, crew_name: crew, representative_name: representative });
  } catch (error) { return jsonError(error instanceof Error ? error.message : "크루 추가에 실패했습니다.", 500); }
}
export async function DELETE(request: Request) {
  try { const session=await getSessionFromCookies(); if(!session) return jsonError("로그인이 필요합니다.",401); const admin=await getAdmin(session.loginId); if(!admin?.is_superadmin) return jsonError("최고 관리자만 크루를 삭제할 수 있습니다.",403); const {crew_name}=await request.json() as {crew_name?:string}; if(!crew_name?.trim()) return jsonError("삭제할 크루를 선택해주세요."); await deleteCrew(crew_name.trim()); await requestCollectorRefresh(session.loginId); return NextResponse.json({ok:true}); }
  catch(error) { return jsonError(error instanceof Error?error.message:"크루 삭제에 실패했습니다.",500); }
}
